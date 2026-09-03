import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BrowserLaunchError,
  chromePath,
  launchBrowser,
  rethrowLaunchFailure,
} from './browser-launch.ts';

// More than a raw pipe's 64 KB buffer, so the capture is exercised at a volume
// a launch going wrong can actually reach rather than a token line or two.
const NOISE_LINES = 1_400;
const NOISE_LINE = 'stub-noise 0123456789012345678901234567890123456789012345678901234567890123456789';
const FLOOD_BYTES = NOISE_LINES * (NOISE_LINE.length + 6);

const scratch = mkdtempSync(join(tmpdir(), 'agentkit-launch-'));
const chrome = chromePath();
let debugPort = 0;
let server: ReturnType<typeof Bun.serve> | undefined;

function pageTarget(): string {
  return `ws://127.0.0.1:${debugPort}/devtools/page/stub`;
}

// The launcher's contract stops at the devtools endpoint, so the stub only has
// to answer /json/list the way a browser does — no real CDP socket is needed.
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== '/json/list') return new Response('no', { status: 404 });
      return Response.json([{ type: 'page', webSocketDebuggerUrl: pageTarget() }]);
    },
  });
  debugPort = server.port;
});

afterAll(() => {
  server?.stop(true);
  rmSync(scratch, { force: true, recursive: true });
});

interface StubOptions {
  flood?: boolean;
  publishOnAttempt?: number;
  ignoreTerm?: boolean;
  writeBackAfterDeath?: boolean;
}

// Stands in for the renderer and GPU children that outlive a killed Chrome: an
// orphan writing profile state back once its parent is already gone.
function writeBackScript(): string {
  const path = join(scratch, 'write-back.sh');
  writeFileSync(path, '#!/bin/sh\nsleep 0.1\nmkdir -p "$1/Default"\necho state > "$1/Default/Network Persistent State"\n');
  chmodSync(path, 0o755);
  return path;
}

function stub(name: string, options: StubOptions = {}): string {
  const path = join(scratch, `${name}.sh`);
  const counter = join(scratch, `${name}.count`);
  const log = join(scratch, `${name}.log`);
  const flood = options.flood
    ? `i=0\nwhile [ \$i -lt ${NOISE_LINES} ]; do\n  echo "${NOISE_LINE} \$i" >&2\n  i=\$((i + 1))\ndone\n`
    : `echo "${NOISE_LINE} solitary" >&2\n`;
  const publish = options.publishOnAttempt === undefined
    ? ''
    : `if [ "\$attempt" -ge ${options.publishOnAttempt} ]; then\n`
      + `  printf '%s\\n%s\\n' "${debugPort}" "/devtools/browser/stub" > "\$profile/DevToolsActivePort"\n`
      + `fi\n`;
  writeFileSync(
    path,
    `#!/bin/sh\n`
      + `profile=""\n`
      + `for arg in "\$@"; do\n`
      + `  case "\$arg" in --user-data-dir=*) profile=\${arg#--user-data-dir=} ;; esac\n`
      + `done\n`
      + `attempt=\$(( \$(cat "${counter}" 2>/dev/null || echo 0) + 1 ))\n`
      + `echo "\$attempt" > "${counter}"\n`
      // Each run records its own pid and profile, and whether the run before it
      // was still alive — the retry's two claims, observed where they happen.
      + `previous=PREV_DEAD\n`
      + `if [ -s "${log}" ]; then\n`
      + `  if kill -0 "\$(head -n 1 "${log}" | cut -d' ' -f2)" 2>/dev/null; then previous=PREV_ALIVE; fi\n`
      + `else\n`
      + `  previous=FIRST\n`
      + `fi\n`
      + `echo "\$attempt \$\$ \$profile \$previous" >> "${log}"\n`
      + flood
      + publish
      + (options.ignoreTerm
        ? `trap '' TERM\nwhile : ; do sleep 0.2; done\n`
        : options.writeBackAfterDeath
        ? `trap '${writeBackScript()} "\$profile" & exit 0' TERM\nwhile : ; do sleep 0.1; done\n`
        // exec so a kill reaches this process: a lingering child would hold the
        // stderr pipe open and the launcher would wait on an EOF that never came.
        : `exec sleep 60\n`),
  );
  chmodSync(path, 0o755);
  for (const stale of [counter, log]) if (existsSync(stale)) rmSync(stale);
  return path;
}

function runs(name: string): { attempt: string; pid: string; profile: string; previous: string }[] {
  const log = join(scratch, `${name}.log`);
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean).map((line) => {
    const [attempt, pid, profile, previous] = line.split(' ');
    return { attempt: attempt ?? '', pid: pid ?? '', profile: profile ?? '', previous: previous ?? '' };
  });
}

function attempts(name: string): number {
  const counter = join(scratch, `${name}.count`);
  return existsSync(counter) ? Number(readFileSync(counter, 'utf-8').trim()) : 0;
}

describe('launching a browser for the devtools endpoint', () => {
  test('a browser flooding stderr is captured to its last line, and still launches', async () => {
    expect(FLOOD_BYTES).toBeGreaterThan(65_536);
    const launch = await launchBrowser({
      binary: stub('flooder', { flood: true, publishOnAttempt: 1 }),
      attemptMs: 15_000,
      attempts: 1,
    });
    try {
      expect(launch.endpoint).toBe(pageTarget());
      expect(launch.stderrTail(200)).toContain(`${NOISE_LINE} ${NOISE_LINES - 1}`);
      // Bounded, or a chatty browser would grow the harness without limit.
      expect(launch.stderrTail(40).split('\n')).toHaveLength(40);
      expect(launch.stderrTail(40)).not.toContain(`${NOISE_LINE} 0\n`);
    } finally {
      await launch.close();
    }
  }, 60_000);

  test('a launch that times out reports the browser stderr it swallowed before', async () => {
    const promise = launchBrowser({
      binary: stub('silent', { flood: true }),
      attemptMs: 1_500,
      attempts: 1,
    });
    await expect(promise).rejects.toThrow(/last 40 lines of browser stderr/);
    await promise.catch((error: Error) => {
      expect(error.message).toContain(`${NOISE_LINE} ${NOISE_LINES - 1}`);
      expect(error.message).toContain('port file never appeared');
    });
  }, 60_000);

  test('a stillborn first launch is retried on a fresh profile, the first one dead', async () => {
    const launch = await launchBrowser({
      binary: stub('second-time-lucky', { publishOnAttempt: 2 }),
      attemptMs: 1_500,
      attempts: 2,
    });
    try {
      expect(attempts('second-time-lucky')).toBe(2);
      expect(launch.endpoint).toBe(pageTarget());
      const [first, second] = runs('second-time-lucky');
      // A retry into the same profile would inherit the failed launch's lock
      // files, and a retry alongside a live browser competes with it for them.
      expect(second?.profile).not.toBe(first?.profile);
      expect(second?.previous).toBe('PREV_DEAD');
    } finally {
      await launch.close();
    }
  }, 60_000);

  test('a second failure surfaces both attempts and the ceiling it spent', async () => {
    const promise = launchBrowser({
      binary: stub('never', {}),
      attemptMs: 1_000,
      attempts: 2,
    });
    await expect(promise).rejects.toThrow(/after 2 attempts of 1000ms \(2000ms ceiling\)/);
    await promise.catch((error: Error) => {
      expect(error.message).toContain('attempt 1/2');
      expect(error.message).toContain('attempt 2/2');
    });
    expect(attempts('never')).toBe(2);
  }, 60_000);
  test('a launch that fails rejects as BrowserLaunchError, a class no assertion produces', async () => {
    const promise = launchBrowser({ binary: stub('typed', {}), attemptMs: 1_000, attempts: 1 });
    await expect(promise).rejects.toBeInstanceOf(BrowserLaunchError);
    await promise.catch((error: Error) => expect(error.name).toBe('BrowserLaunchError'));
  }, 60_000);

  // The distinction that matters on CI: a sanitiser regression and a browser
  // that never started must not read alike, or the real one gets rerun away.
  test('a launch failure and a failed assertion are told apart by the caller', () => {
    let assertionFailure: unknown;
    try {
      expect('drawn <script>').not.toContain('<script');
    } catch (error) {
      assertionFailure = error;
    }
    expect(assertionFailure).toBeInstanceOf(Error);
    expect(assertionFailure).not.toBeInstanceOf(BrowserLaunchError);
    expect(() => rethrowLaunchFailure(assertionFailure, 'the sanitiser assertions')).toThrow(
      /<script/,
    );
    try {
      rethrowLaunchFailure(assertionFailure, 'the sanitiser assertions');
    } catch (error) {
      expect(error).toBe(assertionFailure);
    }

    const stillborn = new BrowserLaunchError('port file never appeared');
    expect(() => rethrowLaunchFailure(stillborn, 'the sanitiser assertions')).toThrow(
      /the sanitiser assertions never ran: the browser did not launch/,
    );
    try {
      rethrowLaunchFailure(stillborn, 'the sanitiser assertions');
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserLaunchError);
      expect((error as Error).message).toContain('port file never appeared');
    }
  });
  // SIGTERM only asks. A browser that declines and is waited on unbounded runs
  // past the stated ceiling, and bun's case timeout then discards the stderr
  // report and the error type this file exists to provide.
  test('a browser ignoring SIGTERM does not outlast the ceiling the error states', async () => {
    const started = Date.now();
    const promise = launchBrowser({
      binary: stub('stubborn', { ignoreTerm: true }),
      attemptMs: 500,
      attempts: 1,
    });
    await expect(promise).rejects.toBeInstanceOf(BrowserLaunchError);
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 30_000);

  test.if(chrome !== null)('closing a real browser leaves no profile directory behind', async () => {
    const launch = await launchBrowser({ binary: chrome as string });
    expect(existsSync(launch.profile)).toBe(true);
    // Chrome writes profile state back as it shuts down, so a delete that does
    // not wait for the exit is undone by the browser it just killed.
    await launch.close();
    expect(existsSync(launch.profile)).toBe(false);
  }, 60_000);
  test('a profile written back to after the browser dies is still removed', async () => {
    const launch = await launchBrowser({
      binary: stub('write-backer', { publishOnAttempt: 1, writeBackAfterDeath: true }),
      attemptMs: 5_000,
      attempts: 1,
    });
    await launch.close();
    expect(existsSync(launch.profile)).toBe(false);
    // The orphan's write lands after the first delete; the directory has to
    // stay gone, not merely have been gone once.
    await Bun.sleep(400);
    expect(existsSync(launch.profile)).toBe(false);
  }, 30_000);
});

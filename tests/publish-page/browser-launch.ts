import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ATTEMPT_MS = 20_000;
const ATTEMPTS = 2;
const REAP_MS = 2_000;
const PROFILE_RM_MS = 5_000;
const PROFILE_SETTLE_MS = 1_000;
const FLUSH_MS = 500;
const KEPT_LINES = 200;
const TAIL_LINES = 40;

export class BrowserLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserLaunchError';
  }
}

export interface LaunchOptions {
  binary: string;
  attemptMs?: number;
  attempts?: number;
}

export interface Launched {
  endpoint: string;
  profile: string;
  stderrTail(lines?: number): string;
  close(): Promise<void>;
}

export function chromePath(): string | null {
  const candidates = [
    process.env.AGENTKIT_CHROMIUM,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/google/chrome/chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter((c): c is string => Boolean(c));
  return candidates.find((c) => existsSync(c)) ?? null;
}

function chromeArgs(profile: string): string[] {
  return [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ];
}

// A failed launch's stderr is the only evidence it can carry, and a piped
// stream nobody reads discards all of it. Capture, not unblocking: measured at
// 1.2 MB, an unread Bun pipe does not stall its writer the way a raw one does.
async function drain(stream: unknown, keep?: string[]): Promise<void> {
  if (typeof stream !== 'object' || stream === null) return;
  const decoder = new TextDecoder();
  let partial = '';
  try {
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      partial += decoder.decode(chunk, { stream: true });
      if (!keep) {
        partial = '';
        continue;
      }
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) keep.push(line);
      if (keep.length > KEPT_LINES) keep.splice(0, keep.length - KEPT_LINES);
    }
  } catch {
    // The browser is killed while a read is in flight on every failure path.
  }
  if (keep && partial) keep.push(partial);
}

// Chrome flushes profile state during shutdown and writes it back after a
// delete, so a profile removed before the reap survives. SIGTERM only asks,
// hence the bounded grace: a browser ignoring it must not outlast the ceiling.
async function reap(child: Bun.Subprocess): Promise<void> {
  child.kill();
  const settled = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(REAP_MS).then(() => false),
  ]);
  if (settled) return;
  child.kill('SIGKILL');
  await Promise.race([child.exited, Bun.sleep(REAP_MS)]);
}

// Chrome's renderer and GPU children outlive the browser process that was
// killed, and write profile state back after the directory is deleted — so one
// removal leaves it behind. Remove again while anything recreates it.
async function removeProfile(profile: string): Promise<void> {
  const deadline = Date.now() + PROFILE_RM_MS;
  let goneAt = Date.now();
  for (;;) {
    if (existsSync(profile)) {
      rmSync(profile, { force: true, recursive: true });
      goneAt = Date.now();
    }
    if (Date.now() - goneAt >= PROFILE_SETTLE_MS || Date.now() >= deadline) return;
    await Bun.sleep(50);
  }
}

function tail(lines: readonly string[], count: number): string {
  return lines.slice(-count).join('\n');
}

async function waitForEndpoint(profile: string, deadline: number): Promise<string> {
  const portFile = join(profile, 'DevToolsActivePort');
  let lastFailure = 'port file never appeared';
  while (Date.now() < deadline) {
    // Chrome writes the port file non-atomically and opens the socket after —
    // an empty read or a refused connection is "not yet", never fatal. The
    // unguarded fetch here once escaped the loop as a ConnectionRefused on
    // 127.0.0.1:80 (empty port), wasting the whole retry budget on one race.
    if (existsSync(portFile)) {
      const [port] = readFileSync(portFile, 'utf-8').split('\n');
      if (/^\d+$/.test(port ?? '')) {
        try {
          // The loop deadline only checks between iterations; an accepted-but-
          // silent socket would otherwise pin a single fetch past all of it.
          const reply = await fetch(`http://127.0.0.1:${port}/json/list`, {
            signal: AbortSignal.timeout(1_000),
          });
          const targets = await reply.json() as { type?: string; webSocketDebuggerUrl?: string }[];
          const page = targets.find((t) => t.type === 'page');
          if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
          lastFailure = `no page target on port ${port} yet`;
        } catch (error) {
          lastFailure = `port ${port} not answering yet: ${error}`;
        }
      } else {
        lastFailure = `port file present but holds ${JSON.stringify(port)}`;
      }
    } else if (lastFailure !== 'port file never appeared') {
      lastFailure = 'port file vanished after appearing — the browser exited';
    }
    await Bun.sleep(50);
  }
  throw new Error(lastFailure);
}

function reportAttempt(attempt: number, of: number, profile: string, why: string, stderr: string[]): string {
  return `attempt ${attempt}/${of} in ${profile}: ${why}\n`
    + `--- last ${TAIL_LINES} lines of browser stderr (attempt ${attempt}) ---\n`
    + `${tail(stderr, TAIL_LINES) || '(the browser wrote nothing to stderr)'}`;
}

export async function launchBrowser(options: LaunchOptions): Promise<Launched> {
  const attempts = options.attempts ?? ATTEMPTS;
  const attemptMs = options.attemptMs ?? ATTEMPT_MS;
  const failures: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const profile = mkdtempSync(join(tmpdir(), 'agentkit-chrome-'));
    const stderr: string[] = [];
    const child = Bun.spawn([options.binary, ...chromeArgs(profile)], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const reading = Promise.all([drain(child.stdout), drain(child.stderr, stderr)]);
    try {
      const endpoint = await waitForEndpoint(profile, Date.now() + attemptMs);
      return {
        endpoint,
        profile,
        stderrTail: (lines = TAIL_LINES) => tail(stderr, lines),
        async close() {
          await reap(child);
          await removeProfile(profile);
        },
      };
    } catch (error) {
      await reap(child);
      // A killed browser can leave a child holding the pipe, so the flush is
      // bounded rather than waited on: a tail is worth more than a hang.
      await Promise.race([reading, Bun.sleep(FLUSH_MS)]);
      failures.push(reportAttempt(attempt, attempts, profile, (error as Error).message, stderr));
      await removeProfile(profile);
    }
  }
  throw new BrowserLaunchError(
    `browser never published a usable devtools endpoint after ${attempts} attempts of `
      + `${attemptMs}ms (${attempts * attemptMs}ms ceiling)\n${failures.join('\n')}`,
  );
}

// A case whose browser never started asserted nothing about its own subject. It
// has to say so, or a real regression is indistinguishable from the flake in a
// CI log and gets waved through on a rerun.
export function rethrowLaunchFailure(error: unknown, subject: string): never {
  if (error instanceof BrowserLaunchError) {
    throw new BrowserLaunchError(`${subject} never ran: the browser did not launch\n${error.message}`);
  }
  throw error;
}

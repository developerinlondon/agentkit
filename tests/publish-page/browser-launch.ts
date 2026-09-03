import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ATTEMPT_MS = 20_000;
const ATTEMPTS = 2;
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
  args?: (profile: string) => string[];
  attemptMs?: number;
  attempts?: number;
}

export interface Launched {
  endpoint: string;
  profile: string;
  stderrTail(lines?: number): string;
  close(): void;
}

export function chromeArgs(profile: string): string[] {
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

export async function launchBrowser(options: LaunchOptions): Promise<Launched> {
  const attempts = options.attempts ?? ATTEMPTS;
  const attemptMs = options.attemptMs ?? ATTEMPT_MS;
  const buildArgs = options.args ?? chromeArgs;
  const failures: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const profile = mkdtempSync(join(tmpdir(), 'agentkit-chrome-'));
    const stderr: string[] = [];
    const child = Bun.spawn([options.binary, ...buildArgs(profile)], {
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
        close() {
          child.kill();
          rmSync(profile, { force: true, recursive: true });
        },
      };
    } catch (error) {
      child.kill();
      await child.exited;
      // A killed browser can leave a child holding the pipe, so the flush is
      // bounded rather than waited on: a tail is worth more than a hang.
      await Promise.race([reading, Bun.sleep(500)]);
      failures.push(
        `attempt ${attempt}/${attempts} in ${profile}: ${(error as Error).message}\n`
          + `--- last ${TAIL_LINES} lines of browser stderr (attempt ${attempt}) ---\n`
          + `${tail(stderr, TAIL_LINES) || '(the browser wrote nothing to stderr)'}`,
      );
      rmSync(profile, { force: true, recursive: true });
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

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Budget } from '../../skills/taste/scripts/rules/budget.ts';
import { JUDGMENT } from '../../skills/taste/scripts/rules/judgment.ts';
import type { KindRequest, MatchOutcome } from '../../skills/taste/scripts/rules/kinds.ts';

// Nothing here may reach api.typesafe.ai. Port 9 is discard: a test that
// forgets its stub fails on a refused connection rather than on the vendor.
const NOWHERE = 'http://127.0.0.1:9';

export const POLICY = 'No stopgaps.\n\nWhy: a workaround left in place is the next outage.\n\n'
  + 'How to apply: fix the cause, or say why the workaround is the fix.';
export const QUESTION = 'Does this change ship a workaround that leaves the real fix for later?';

const sandboxes: string[] = [];
const servers: { stop(force?: boolean): void }[] = [];

export function cleanUp(): void {
  while (servers.length > 0) (servers.pop() as { stop(force?: boolean): void }).stop(true);
  while (sandboxes.length > 0) rmSync(sandboxes.pop() as string, { recursive: true, force: true });
}

export function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentkit-judgment-'));
  sandboxes.push(root);
  return root;
}

export function git(dir: string, ...args: string[]): void {
  const result = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
}

// A repository whose one staged change is the thing the judgment reads.
export function repo(options: { staged?: boolean; marker?: string } = {}): string {
  const marker = options.marker ?? 'stopgap until the fix';
  const dir = scratch();
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'retry.ts'), 'export const retries = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'one');
  if (options.staged === false) return dir;
  writeFileSync(join(dir, 'retry.ts'), `export const retries = 1; // ${marker}\n`);
  git(dir, 'add', '-A');
  return dir;
}

export interface Body {
  model: string;
  state: Record<string, string>;
  questions: Record<string, { type: string; instructions: Record<string, string> }>;
}

interface Sent {
  body: Body;
  authorization: string | null;
}

interface Stub {
  url: string;
  sent: Sent[];
}

export function provider(
  options: { noul?: number; nouls?: number[]; status?: number; hang?: boolean } = {},
): Stub {
  const sent: Sent[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request: Request) {
      sent.push({
        body: await request.json() as Body,
        authorization: request.headers.get('authorization'),
      });
      if (options.hang === true) return await new Promise<Response>(() => {});
      if (options.status !== undefined) return new Response('refused', { status: options.status });
      const answered = options.nouls?.[sent.length - 1] ?? options.noul ?? 0;
      return Response.json({
        model: 'jev-1.13.0',
        answers: { q: { type: 'noul', noul: answered } },
        usage: { input_tokens: 307, output_tokens: 20 },
      });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, sent };
}

// A git that answers nothing and writes down that it was asked. The verdict
// alone cannot tell a check that never ran from one that ran and found nothing,
// so whether git was reached at all is observed rather than inferred.
export function recordingGit(): { dir: string; asked: () => boolean } {
  const dir = scratch();
  const marker = join(dir, 'asked');
  const path = join(dir, 'git');
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(marker)}\nexit 0\n`);
  chmodSync(path, 0o755);
  return { dir, asked: () => existsSync(marker) };
}

export function refuseToMatch(): Promise<MatchOutcome> {
  throw new Error('a judgment rule never compiles a pattern');
}

interface Options {
  command?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  body?: string;
  url?: string;
  budget?: Budget;
}

export function evaluate(fields: Record<string, string>, options: Options = {}) {
  const home = scratch();
  const request: KindRequest = {
    command: options.command ?? 'git commit -m "paper over the retry"',
    cwd: options.cwd ?? repo(),
    env: {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      TYPESAFE_API_KEY: 'sk-test',
      TYPESAFE_BASE_URL: options.url ?? NOWHERE,
      ...options.env,
    },
    match: refuseToMatch as KindRequest['match'],
    body: options.body ?? POLICY,
    budget: options.budget,
  };
  return JUDGMENT.evaluate({ question: QUESTION, ...fields }, request);
}

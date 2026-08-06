import { runBounded } from './run.ts';

export type Visibility = 'public' | 'private' | 'unknown';

export interface Target {
  visibility: Visibility;
  detail: string;
}

// Named on the command, the way every other deliberate exception in this
// toolchain is. It asserts a fact the tool could not establish — that this
// repository is private — and asserts nothing about a repository the forge
// already answered for.
export const TARGET_PRIVATE_OVERRIDE = 'AGENTKIT_TASTE_TARGET_PRIVATE';

export const FORGE_TIMEOUT_MS = 20_000;

// Asked without a URL, both CLIs pick a repository from every remote by their
// own precedence — gh prefers `upstream` over `origin` — and answer about one
// the caller never read. The URL is therefore always passed.
interface Forge {
  cli: string;
  args(url: string): string[];
  read(out: string): Visibility;
}

// Internal is not private: every account on the instance can read it, and this
// guard exists to keep the owner's words off surfaces they do not control.
// Anything unrecognised stays unknown, which refuses rather than guesses.
function named(word: string): Visibility {
  const value = word.trim().toLowerCase();
  if (value === 'private') return 'private';
  if (value === 'public' || value === 'internal') return 'public';
  return 'unknown';
}

const GITHUB: Forge = {
  cli: 'gh',
  args: (url: string) => ['repo', 'view', url, '--json', 'visibility', '--jq', '.visibility'],
  read: named,
};

const GITLAB: Forge = {
  cli: 'glab',
  args: (url: string) => ['repo', 'view', url, '-F', 'json'],
  read(out: string): Visibility {
    try {
      const project = JSON.parse(out) as { visibility?: unknown };
      return typeof project.visibility === 'string' ? named(project.visibility) : 'unknown';
    } catch {
      return 'unknown';
    }
  },
};

// Where a store's snapshot would land if the tree around it were pushed.
// Nothing outside a work tree can reach a forge, so nothing there is published.
export async function containingWorkTree(
  path: string,
  env: Record<string, string | undefined> = process.env,
  timeoutMs: number = FORGE_TIMEOUT_MS,
): Promise<string | undefined> {
  const top = await runBounded(
    ['git', '-C', path, 'rev-parse', '--show-toplevel'],
    path,
    env,
    timeoutMs,
  );
  return top.ok && top.out !== '' ? top.out.split('\n')[0]?.trim() : undefined;
}

function hostOf(url: string): string {
  const scp = /^[^/]*@([^:/]+):/.exec(url);
  if (scp !== null) return scp[1] as string;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^:/]+)/i.exec(url);
  return scheme === null ? '' : (scheme[1] as string);
}

function forgeFor(url: string): Forge | undefined {
  const host = hostOf(url).toLowerCase();
  if (host.includes('github')) return GITHUB;
  if (host.includes('gitlab')) return GITLAB;
  return undefined;
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? 'no output';
}

// What the repository being written to actually is, read from the forge that
// hosts it. Every failure — no checkout, no remote, no CLI, a CLI that errors,
// an answer nobody recognises — lands on unknown with the reason attached,
// because the caller refuses on unknown and the owner is owed the why.
export async function repoVisibility(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
  timeoutMs: number = FORGE_TIMEOUT_MS,
): Promise<Target> {
  const origin = await runBounded(['git', 'remote', 'get-url', 'origin'], cwd, env, timeoutMs);
  if (!origin.ok || origin.out === '') {
    return {
      visibility: 'unknown',
      detail: `no git remote named origin in ${cwd} — ${firstLine(origin.err)}`,
    };
  }

  const url = firstLine(origin.out);
  if (url.startsWith('-')) {
    return {
      visibility: 'unknown',
      detail: `origin ${JSON.stringify(url)} begins with "-", which a forge CLI reads as an `
        + 'option rather than a repository',
    };
  }

  const forge = forgeFor(url);
  if (forge === undefined) {
    return {
      visibility: 'unknown',
      detail: `origin ${url} is not a github or gitlab remote, and nothing else can be asked`,
    };
  }

  const view = await runBounded([forge.cli, ...forge.args(url)], cwd, env, timeoutMs);
  if (!view.ok) {
    return {
      visibility: 'unknown',
      detail: `${forge.cli} could not answer for ${url} — ${firstLine(view.err || view.out)}`,
    };
  }

  const visibility = forge.read(view.out);
  return {
    visibility,
    detail: visibility === 'unknown'
      ? `${forge.cli} answered ${JSON.stringify(firstLine(view.out))} for ${url}, which names no `
        + 'visibility this understands'
      : `${forge.cli} reports ${url} is ${visibility}`,
  };
}

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateCommand } from '../../skills/taste/scripts/police.ts';
import { resolveTastes } from '../../skills/taste/scripts/resolve.ts';
import { readSources } from '../../skills/taste/scripts/sources.ts';
import { syncSources } from '../../skills/taste/scripts/sync.ts';
import { remote, removeScratch, scratch, taste } from './fixtures.ts';

afterEach(removeScratch);

const GENERIC = 'git@github.com:developerinlondon/agentkit-tastes.git';
const CENTRAL = 'git@github.com:developerinlondon/business-tastes.git';

function config(...sources: string[]): string {
  return `taste:\n  enabled: true\n  sources:\n${sources.join('\n')}\n`;
}

function source(repo: string, extra: Record<string, string> = {}): string {
  const lines = [`    - repo: ${repo}`];
  for (const [key, value] of Object.entries(extra)) lines.push(`      ${key}: ${value}`);
  return lines.join('\n');
}

const BOTH = config(
  source(GENERIC, { ref: 'v2026.08.1' }),
  source(CENTRAL, { ref: 'v2026.08.4' }),
);

function where(files: Record<string, string>, homeFiles: Record<string, string> = {}) {
  return { cwd: scratch(files), home: scratch(homeFiles) };
}

function declare(files: Record<string, string>, homeFiles: Record<string, string> = {}) {
  const { cwd, home } = where(files, homeFiles);
  return readSources(cwd, home, {});
}

describe('a source is declared in committed config', () => {
  test('the sources list keeps the order it was written in', () => {
    const { sources, errors } = declare({ '.agentkit/config.yaml': BOTH });

    expect(errors).toEqual([]);
    expect(sources.map((entry) => entry.name)).toEqual(['agentkit-tastes', 'business-tastes']);
    expect(sources[0]?.repo).toBe(GENERIC);
    expect(sources[1]?.ref).toBe('v2026.08.4');
  });

  test('vendored is the mode a source gets when it does not say', () => {
    const { sources } = declare({ '.agentkit/config.yaml': BOTH });

    expect(sources.every((entry) => entry.mode === 'vendored')).toBe(true);
  });

  test('the name defaults to the repository, and an explicit one wins', () => {
    const { sources } = declare({
      '.agentkit/config.yaml': config(source(CENTRAL, { ref: 'main', name: 'policy' })),
    });

    expect(sources[0]?.name).toBe('policy');
  });

  test('an optional path narrows the source to a subdirectory', () => {
    const { sources } = declare({
      '.agentkit/config.yaml': config(source(GENERIC, { ref: 'main', path: 'tastes/' })),
    });

    expect(sources[0]?.path).toBe('tastes/');
  });

  test('no sources key at all is not an error — it is the common repository', () => {
    const { sources, errors } = declare({ '.agentkit/config.yaml': 'taste:\n  enabled: true\n' });

    expect(sources).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('the user config declares sources when the project does not', () => {
    const { sources } = declare({}, {
      '.config/agentkit/config.yaml': config(source(CENTRAL, { ref: 'main' })),
    });

    expect(sources.map((entry) => entry.name)).toEqual(['business-tastes']);
  });

  test('a project list replaces the user list rather than appending to it', () => {
    const { sources } = declare(
      { '.agentkit/config.yaml': config(source(GENERIC, { ref: 'main' })) },
      { '.config/agentkit/config.yaml': config(source(CENTRAL, { ref: 'main' })) },
    );

    expect(sources.map((entry) => entry.name)).toEqual(['agentkit-tastes']);
  });
});

describe('a declaration the resolver cannot act on is refused, by name', () => {
  function errorsFor(body: string): string {
    return declare({ '.agentkit/config.yaml': body }).errors.join('\n');
  }

  test('reference mode says it is deferred rather than pretending to cache', () => {
    const errors = errorsFor(config(source(CENTRAL, { ref: 'main', mode: 'reference' })));

    expect(errors).toContain('reference');
    expect(errors).toContain('deferred');
    expect(errors).toContain('mode: vendored');
  });

  test('a deferred source is dropped, not silently treated as vendored', () => {
    const { sources } = declare({
      '.agentkit/config.yaml': config(source(CENTRAL, { ref: 'main', mode: 'reference' })),
    });

    expect(sources).toEqual([]);
  });

  test('an unknown mode names what is accepted', () => {
    expect(errorsFor(config(source(CENTRAL, { ref: 'main', mode: 'symlink' })))).toContain(
      'vendored',
    );
  });

  test('a source without a ref is refused — a pin is the point', () => {
    expect(errorsFor(config(source(CENTRAL)))).toContain('ref');
  });

  test('a source without a repo is refused, naming its position', () => {
    expect(errorsFor('taste:\n  sources:\n    - ref: main\n')).toContain('sources[0]');
  });

  test('an unknown source key is refused rather than ignored', () => {
    expect(errorsFor(config(source(CENTRAL, { ref: 'main', on_unreachable: 'warn' })))).toContain(
      'on_unreachable',
    );
  });

  test('two sources cannot claim one vendor directory', () => {
    const errors = errorsFor(config(
      source(GENERIC, { ref: 'a', name: 'shared' }),
      source(CENTRAL, { ref: 'b', name: 'shared' }),
    ));

    expect(errors).toContain('duplicate');
    expect(errors).toContain('shared');
  });

  test('a name that would escape the vendor directory is refused', () => {
    expect(errorsFor(config(source(CENTRAL, { ref: 'main', name: '"../../etc"' })))).toContain(
      'name',
    );
  });

  test('a repo that names a transport helper is refused', () => {
    const errors = errorsFor(config(source('"ext::touch /tmp/pwn"', { ref: 'v1' })));

    expect(errors).toContain('transport helper');
    expect(errors).toContain('runs a program');
  });

  test('a repo that begins with a dash is refused', () => {
    expect(errorsFor(config(source('"--upload-pack=id"', { ref: 'v1' })))).toContain('option');
  });

  test.each([
    ['an ssh URL', 'ssh://git@example.invalid/org/tastes.git'],
    ['an scp-style ssh path', 'git@example.invalid:org/tastes.git'],
    ['an https URL', 'https://example.invalid/org/tastes.git'],
    ['a file URL', 'file:///srv/tastes.git'],
    ['an absolute path', '/srv/tastes.git'],
  ])('a repo that is %s is accepted', (_shape, repo) => {
    const { sources, errors } = declare({
      '.agentkit/config.yaml': config(source(JSON.stringify(repo), { ref: 'v1', name: 'x' })),
    });

    expect(errors).toEqual([]);
    expect(sources[0]?.repo).toBe(repo);
  });

  test('a ref that is really a git option is refused', () => {
    const errors = errorsFor(
      config(source(CENTRAL, { ref: '"--upload-pack=touch /tmp/pwn"' })),
    );

    expect(errors).toContain('ref');
    expect(errors).toContain('git option');
  });

  test.each([
    ['a long option', '--upload-pack=touch /tmp/pwn'],
    ['a short option', '-u'],
    ['a leading dash on an otherwise ordinary name', '-main'],
    ['a command substitution', 'v1$(touch /tmp/pwn)'],
    ['a backtick', 'v1`id`'],
    ['a space', 'v1 --upload-pack=id'],
    ['a semicolon', 'v1;id'],
    ['the parent-directory sequence git reserves', 'refs/heads/../../evil'],
    ['a reflog selector', 'main@{yesterday}'],
    ['the .lock suffix git reserves', 'main.lock'],
  ])('a ref carrying %s is refused', (_shape, ref) => {
    expect(errorsFor(config(source(CENTRAL, { ref: JSON.stringify(ref) })))).toContain('ref');
  });

  // The allowlist has to leave the refs people actually pin usable, or the
  // guard gets turned off rather than obeyed.
  test.each([
    ['a branch', 'main'],
    ['a namespaced branch', 'feat/tastes-phase3'],
    ['a version tag', 'v2026.08.1'],
    ['a tag with an underscore', 'release_2026'],
    ['a full commit sha', '4f1c2be9a7d0e3b8c5a19f7264e0d3b1c8a5f2e9'],
  ])('a ref that is %s is accepted', (_shape, ref) => {
    const { sources, errors } = declare({
      '.agentkit/config.yaml': config(source(CENTRAL, { ref })),
    });

    expect(errors).toEqual([]);
    expect(sources[0]?.ref).toBe(ref);
  });

  test('a path that would escape the checkout is refused', () => {
    expect(errorsFor(config(source(CENTRAL, { ref: 'main', path: '"../secrets"' })))).toContain(
      'path',
    );
  });

  test('sources that are not a list are refused', () => {
    expect(errorsFor('taste:\n  sources: agentkit-tastes\n')).toContain('list');
  });
});

const RULE = [
  'rule:',
  '  kind: command',
  '  match: git tag',
  '  remedy: Ask first.',
  '  override: AGENTKIT_TIER',
].join('\n');

function blocking(name: string, remedy: string): string {
  return taste(name, { enforce: 'block', strength: 'require' })
    .replace('provenance:', `${RULE}\nprovenance:`)
    .replace('Ask first.', remedy);
}

describe('external sources stack in the order they were declared', () => {
  const vendored = {
    '.agentkit/config.yaml': BOTH,
    '.agentkit/tastes-vendor/agentkit-tastes/release-tier.md': taste('release-tier'),
    '.agentkit/tastes-vendor/business-tastes/commit-style.md': taste('commit-style'),
  };

  test('every declared source contributes its tastes', () => {
    const { cwd, home } = where(vendored);
    const { tastes } = resolveTastes(cwd, home, {});

    expect(tastes.map((entry) => entry.name)).toEqual(['commit-style', 'release-tier']);
    expect(tastes.every((entry) => entry.layer === 'external')).toBe(true);
  });

  test('the winning external taste names the source it came from', () => {
    const { cwd, home } = where(vendored);
    const { tastes } = resolveTastes(cwd, home, {});

    expect(tastes.find((entry) => entry.name === 'release-tier')?.source).toBe('agentkit-tastes');
  });

  // The whole reason sources are a list rather than a set: the private central
  // set is second precisely so it overrides the public generic one.
  test('a later source wins the same name against an earlier one', () => {
    const { cwd, home } = where({
      '.agentkit/config.yaml': BOTH,
      '.agentkit/tastes-vendor/agentkit-tastes/release-tier.md': taste('release-tier', {}, 'generic'),
      '.agentkit/tastes-vendor/business-tastes/release-tier.md': taste('release-tier', {}, 'central'),
    });
    const resolved = resolveTastes(cwd, home, {}).tastes;

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.source).toBe('business-tastes');
    expect(resolved[0]?.shadowedSources).toEqual(['agentkit-tastes']);
  });

  test('reversing the declaration reverses the winner, and nothing else does', () => {
    const files = {
      '.agentkit/tastes-vendor/agentkit-tastes/release-tier.md': taste('release-tier'),
      '.agentkit/tastes-vendor/business-tastes/release-tier.md': taste('release-tier'),
    };
    const reversed = config(
      source(CENTRAL, { ref: 'v2026.08.4' }),
      source(GENERIC, { ref: 'v2026.08.1' }),
    );
    const first = where({ ...files, '.agentkit/config.yaml': BOTH });
    const second = where({ ...files, '.agentkit/config.yaml': reversed });

    expect(resolveTastes(first.cwd, first.home, {}).tastes[0]?.source).toBe('business-tastes');
    expect(resolveTastes(second.cwd, second.home, {}).tastes[0]?.source).toBe('agentkit-tastes');
  });

  test('a project taste beats every source, and a source beats the user layer', () => {
    const { cwd, home } = where({
      '.agentkit/config.yaml': BOTH,
      '.agentkit/tastes/release-tier.md': taste('release-tier', { scope: 'project' }),
      '.agentkit/tastes-vendor/agentkit-tastes/release-tier.md': taste('release-tier'),
      '.agentkit/tastes-vendor/business-tastes/commit-style.md': taste('commit-style'),
    }, {
      '.agentkit/tastes/release-tier.md': taste('release-tier', { scope: 'user' }),
      '.agentkit/tastes/commit-style.md': taste('commit-style', { scope: 'user' }),
    });
    const { tastes } = resolveTastes(cwd, home, {});
    const tier = tastes.find((entry) => entry.name === 'release-tier');

    expect(tier?.layer).toBe('project');
    expect(tier?.shadows).toEqual(['external', 'user']);
    expect(tier?.shadowedSources).toEqual(['agentkit-tastes']);
    expect(tastes.find((entry) => entry.name === 'commit-style')?.layer).toBe('external');
  });

  test('an undeclared vendor directory is inert, and said out loud', () => {
    const { cwd, home } = where({
      '.agentkit/config.yaml': config(source(GENERIC, { ref: 'main' })),
      '.agentkit/tastes-vendor/agentkit-tastes/release-tier.md': taste('release-tier'),
      '.agentkit/tastes-vendor/stowaway/commit-style.md': taste('commit-style'),
    });
    const { tastes, warnings } = resolveTastes(cwd, home, {});

    expect(tastes.map((entry) => entry.name)).toEqual(['release-tier']);
    expect(warnings.join('\n')).toContain('stowaway');
  });

  test('a declared source with nothing vendored warns instead of resolving empty', () => {
    const { cwd, home } = where({ '.agentkit/config.yaml': BOTH });
    const { warnings } = resolveTastes(cwd, home, {});

    expect(warnings.join('\n')).toContain('business-tastes');
    expect(warnings.join('\n')).toContain('sync');
  });

  test('a config error reaches the resolution rather than dropping the layer quietly', () => {
    const { cwd, home } = where({
      '.agentkit/config.yaml': config(source(CENTRAL, { ref: 'main', mode: 'reference' })),
    });

    expect(resolveTastes(cwd, home, {}).warnings.join('\n')).toContain('deferred');
  });

  test('two files with one name inside a single source is that source being broken', () => {
    const { cwd, home } = where({
      '.agentkit/config.yaml': config(source(GENERIC, { ref: 'main' })),
      '.agentkit/tastes-vendor/agentkit-tastes/release-tier.md': taste('release-tier'),
      '.agentkit/tastes-vendor/agentkit-tastes/git/release-tier.md': taste('release-tier'),
    });

    expect(resolveTastes(cwd, home, {}).warnings.join('\n')).toContain('duplicate name');
  });
});

// The payload git actually honours: it parses options after positionals, so a
// ref of `--upload-pack=<program>` names a program it runs on the remote side —
// which, for a local or file:// remote, is this machine. Two independent stops
// exist. The refusal above pins the validator; this pins the outcome, and stays
// green while either one holds.
describe('a source cannot make git run a program', () => {
  test('the payload runs nothing, and lands nothing', () => {
    const upstream = remote({ 'release-tier.md': taste('release-tier') });
    upstream.tag('v1');
    const sentinel = join(scratch(), 'pwn');
    const cwd = scratch({
      '.agentkit/config.yaml': `taste:\n  sources:\n    - repo: ${upstream.url}\n`
        + `      ref: "--upload-pack=touch ${sentinel}"\n      name: evil\n`,
    });

    const result = syncSources({ cwd, home: scratch(), env: {}, today: '2026-08-05' });

    expect(result.ok).toBe(false);
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(join(cwd, '.agentkit', 'tastes-vendor'))).toBe(false);
    expect(existsSync(join(cwd, '.agentkit', 'tastes.lock'))).toBe(false);
  });
});

describe('a fresh clone with no network reads its policy anyway', () => {
  // The repository this stands in for was cloned onto a machine that cannot
  // reach the source at all: the URL resolves to nothing, and there is no git
  // remote configured. Anything that fetched at read time would fail here.
  const UNREACHABLE = 'file:///nonexistent/agentkit-tastes.git';
  const offline = {
    '.agentkit/config.yaml': config(source(UNREACHABLE, { ref: 'v1', name: 'agentkit-tastes' })),
    '.agentkit/tastes.lock': 'agentkit-tastes\t' + UNREACHABLE + '\tv1\tdeadbeef\t2026-08-05\n',
    '.agentkit/tastes-vendor/agentkit-tastes/release-tier.md': blocking(
      'release-tier',
      'Cut a patch tag.',
    ),
  };

  test('the vendored taste resolves with nothing to fetch', () => {
    const { cwd, home } = where(offline);
    const { tastes, warnings } = resolveTastes(cwd, home, {});

    expect(tastes.map((entry) => entry.name)).toEqual(['release-tier']);
    expect(warnings).toEqual([]);
  });

  test('and it still blocks — enforcement reads the working tree, never the remote', async () => {
    const { cwd, home } = where(offline);
    const verdict = await evaluateCommand({ command: 'git tag v0.8.0', cwd, home, env: {} });

    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('Cut a patch tag.');
    expect(verdict.reason).toContain('tastes-vendor/agentkit-tastes/release-tier.md');
  });
});

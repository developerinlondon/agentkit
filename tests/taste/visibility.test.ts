import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type SyncResult, syncSources } from '../../skills/taste/scripts/sync.ts';
import {
  repoVisibility,
  TARGET_PRIVATE_OVERRIDE,
  type Target,
} from '../../skills/taste/scripts/visibility.ts';
import { config, type Remote, remote, removeScratch, scratch, source, taste } from './fixtures.ts';

afterEach(removeScratch);

const TODAY = '2026-08-06';

function upstream(): Remote {
  const built = remote({ 'release-tier.md': taste('release-tier') });
  built.tag('v1');
  return built;
}

function target(visibility: Target['visibility'], detail = 'the fixture said so') {
  return async (): Promise<Target> => ({ visibility, detail });
}

interface Attempt {
  cwd: string;
  home: string;
  result: SyncResult;
}

// The incident, replayed: a source the owner marks private, declared in a
// repository, with the forge answering for that repository. Everything else is
// the same sync the owner runs.
async function vendor(
  declared: Record<string, string>,
  probe: () => Promise<Target>,
  env: Record<string, string | undefined> = {},
  where: 'project' | 'user' = 'project',
): Promise<Attempt> {
  const at = {
    cwd: scratch(
      where === 'project'
        ? { '.agentkit/config.yaml': config(source(upstream().url, declared)) }
        : {},
    ),
    home: scratch(
      where === 'user'
        ? { '.config/agentkit/config.yaml': config(source(upstream().url, declared)) }
        : {},
    ),
  };
  return {
    ...at,
    result: await syncSources({ ...at, env, today: TODAY, probe }),
  };
}

function vendoredInto(root: string, name = 'business'): string {
  return join(root, '.agentkit', 'tastes', 'external', name);
}

const PRIVATE = { ref: 'v1', name: 'business', visibility: 'private' };
const PUBLIC = { ref: 'v1', name: 'business', visibility: 'public' };

describe('a private source is refused entry to a public repository', () => {
  test('the vendoring is refused, and nothing at all is written', async () => {
    const attempt = await vendor(PRIVATE, target('public', 'github.com/owner/agentkit is PUBLIC'));

    expect(attempt.result.ok).toBe(false);
    expect(existsSync(vendoredInto(attempt.cwd))).toBe(false);
    expect(existsSync(join(attempt.cwd, '.agentkit', 'tastes.lock'))).toBe(false);
  });

  test('the refusal names the source, the target and the reason', async () => {
    const attempt = await vendor(PRIVATE, target('public', 'github.com/owner/agentkit is PUBLIC'));
    const refusal = attempt.result.errors.join('\n');

    expect(refusal).toContain('business');
    expect(refusal).toContain('github.com/owner/agentkit is PUBLIC');
    expect(refusal).toContain('private source');
    expect(refusal).toContain('public repository');
  });

  // Where the taste belonged all along. A refusal that only says no leaves the
  // owner with the same problem and no move.
  test('the refusal names the machine scope as the place it belongs', async () => {
    const attempt = await vendor(PRIVATE, target('public'));

    expect(attempt.result.errors.join('\n')).toContain('~/.config/agentkit/config.yaml');
  });

  test('the same source into a private repository is vendored', async () => {
    const attempt = await vendor(PRIVATE, target('private', 'gitlab.com/biz/infra is private'));

    expect(attempt.result.errors).toEqual([]);
    expect(existsSync(vendoredInto(attempt.cwd))).toBe(true);
  });

  test('a public source is vendored into a public repository, unprobed', async () => {
    const probe = async (): Promise<Target> => {
      throw new Error('the forge must not be asked about a public source');
    };
    const attempt = await vendor(PUBLIC, probe);

    expect(attempt.result.errors).toEqual([]);
    expect(existsSync(vendoredInto(attempt.cwd))).toBe(true);
  });
});

// Fail closed: a repository that cannot be shown to be private is treated as
// public. The alternative assumes privacy on no evidence, which is the
// assumption that costs a leak rather than an inconvenience.
describe('a target whose visibility cannot be determined is refused', () => {
  test('an undeterminable target refuses the vendoring', async () => {
    const attempt = await vendor(PRIVATE, target('unknown', 'no gh or glab on PATH'));

    expect(attempt.result.ok).toBe(false);
    expect(existsSync(vendoredInto(attempt.cwd))).toBe(false);
  });

  test('the refusal says why it could not tell, and names the override', async () => {
    const attempt = await vendor(PRIVATE, target('unknown', 'no gh or glab on PATH'));
    const refusal = attempt.result.errors.join('\n');

    expect(refusal).toContain('no gh or glab on PATH');
    expect(refusal).toContain('could not be determined');
    expect(refusal).toContain(TARGET_PRIVATE_OVERRIDE);
  });

  test('the override lets a deliberate vendoring through', async () => {
    const attempt = await vendor(PRIVATE, target('unknown'), { [TARGET_PRIVATE_OVERRIDE]: '1' });

    expect(attempt.result.errors).toEqual([]);
    expect(existsSync(vendoredInto(attempt.cwd))).toBe(true);
  });

  test('a granted override is reported rather than passing silently', async () => {
    const attempt = await vendor(PRIVATE, target('unknown'), { [TARGET_PRIVATE_OVERRIDE]: '1' });

    expect(attempt.result.report.join('\n')).toContain(TARGET_PRIVATE_OVERRIDE);
  });

  // A guard that can be switched off by mistyping its escape hatch is worse
  // than no guard: the owner believes it is on.
  test.each(['', '0', 'false', 'no', 'off', 'FALSE'])(
    'the override set to %p still refuses',
    async (value) => {
      const attempt = await vendor(PRIVATE, target('unknown'), {
        [TARGET_PRIVATE_OVERRIDE]: value,
      });

      expect(attempt.result.ok).toBe(false);
      expect(existsSync(vendoredInto(attempt.cwd))).toBe(false);
    },
  );

  test('an off-reading override says the value did not read as deliberate', async () => {
    const attempt = await vendor(PRIVATE, target('unknown'), { [TARGET_PRIVATE_OVERRIDE]: 'no' });

    expect(attempt.result.errors.join('\n')).toContain('does not read as a deliberate override');
  });

  // The override supplies knowledge the tool lacked. It does not contradict
  // knowledge the tool has — which is exactly the case that leaked.
  test('the override does not rescue a target the forge said was public', async () => {
    const attempt = await vendor(PRIVATE, target('public'), { [TARGET_PRIVATE_OVERRIDE]: '1' });

    expect(attempt.result.ok).toBe(false);
    expect(existsSync(vendoredInto(attempt.cwd))).toBe(false);
  });
});

describe('visibility is required of a source a repository vendors', () => {
  test('a source without the key is refused, naming the key', async () => {
    const attempt = await vendor({ ref: 'v1', name: 'business' }, target('private'));
    const refusal = attempt.result.errors.join('\n');

    expect(attempt.result.ok).toBe(false);
    expect(refusal).toContain('visibility');
    expect(refusal).toContain('business');
  });

  test('nothing is written while the key is missing', async () => {
    const attempt = await vendor({ ref: 'v1', name: 'business' }, target('private'));

    expect(existsSync(vendoredInto(attempt.cwd))).toBe(false);
  });

  test.each(['secret', 'internal', 'PUBLIC'])(
    'visibility: %p is refused rather than guessed at',
    async (value) => {
      const attempt = await vendor(
        { ref: 'v1', name: 'business', visibility: value },
        target('private'),
      );

      expect(attempt.result.ok).toBe(false);
      expect(attempt.result.errors.join('\n')).toContain('visibility');
    },
  );
});

// Nothing is published by a machine-level vendoring: the snapshot lands in the
// owner's home directory, which no clone, no CI runner and no forge ever sees.
describe('a machine-level vendoring is not gated on any repository', () => {
  test('a private source vendors into the machine store with no probe at all', async () => {
    const probe = async (): Promise<Target> => {
      throw new Error('a machine-level vendoring must not ask the forge anything');
    };
    const attempt = await vendor(PRIVATE, probe, {}, 'user');

    expect(attempt.result.errors).toEqual([]);
    expect(existsSync(vendoredInto(attempt.home))).toBe(true);
  });

  test('a machine source with no visibility key at all still vendors', async () => {
    const attempt = await vendor({ ref: 'v1', name: 'business' }, target('public'), {}, 'user');

    expect(attempt.result.errors).toEqual([]);
    expect(existsSync(vendoredInto(attempt.home))).toBe(true);
  });
});

// The prober against the shape it is deployed in: a real git checkout with a
// real remote, and the forge CLI answering on PATH.
describe('the target repository is read from the forge', () => {
  // PATH is the whole fixture: the prober finds exactly the forge CLI this
  // directory holds, so "not installed" is a real absence rather than a stub
  // pretending to be one. Git is wrapped because it must keep working while
  // gh and glab do not exist.
  function checkout(remoteUrl: string, cli: Record<string, string> = {}) {
    const bin = scratch({});
    const scripts = { git: `#!/bin/sh\nexec ${Bun.which('git')} "$@"\n`, ...cli };
    for (const [name, script] of Object.entries(scripts)) {
      const path = join(bin, name);
      writeFileSync(path, script);
      chmodSync(path, 0o755);
    }
    const cwd = scratch({ 'README.md': '# target\n' });
    Bun.spawnSync({ cmd: ['git', 'init', '-q', '-b', 'main'], cwd });
    if (remoteUrl !== '') {
      Bun.spawnSync({ cmd: ['git', 'remote', 'add', 'origin', remoteUrl], cwd });
    }
    return { cwd, env: { PATH: bin } };
  }

  function gh(visibility: string): Record<string, string> {
    return { gh: `#!/bin/sh\nprintf '%s\\n' ${visibility}\n` };
  }

  test('a github remote answering PRIVATE reads as private', async () => {
    const at = checkout('git@github.com:owner/secret.git', gh('PRIVATE'));

    expect((await repoVisibility(at.cwd, at.env)).visibility).toBe('private');
  });

  test('a github remote answering PUBLIC reads as public', async () => {
    const at = checkout('git@github.com:owner/agentkit.git', gh('PUBLIC'));

    expect((await repoVisibility(at.cwd, at.env)).visibility).toBe('public');
  });

  // Internal means every account on the instance can read it. That is not the
  // owner's machine, so for this guard it is the public side of the line.
  test('an internal repository is not private', async () => {
    const at = checkout('git@github.com:owner/internal.git', gh('INTERNAL'));

    expect((await repoVisibility(at.cwd, at.env)).visibility).toBe('public');
  });

  test('a gitlab remote is read with glab, and its json visibility field', async () => {
    const at = checkout('git@gitlab.com:bizfoundry/infra.git', {
      glab: '#!/bin/sh\nprintf \'{"id":1,"visibility":"private"}\\n\'\n',
    });

    expect((await repoVisibility(at.cwd, at.env)).visibility).toBe('private');
  });

  test.each([
    ['the forge cli is not installed', 'git@github.com:owner/x.git', {}],
    ['the forge cli fails', 'git@github.com:owner/x.git', { gh: '#!/bin/sh\nexit 1\n' }],
    ['the forge cli answers nonsense', 'git@github.com:owner/x.git', {
      gh: '#!/bin/sh\necho not-a-visibility\n',
    }],
    ['there is no remote at all', '', { gh: '#!/bin/sh\necho PUBLIC\n' }],
    ['the host is neither forge', 'git@git.example.invalid:owner/x.git', {
      gh: '#!/bin/sh\necho PUBLIC\n',
    }],
  ])('%s leaves the visibility unknown', async (_case, remoteUrl, cli) => {
    const at = checkout(remoteUrl, cli as Record<string, string>);
    const read = await repoVisibility(at.cwd, at.env);

    expect(read.visibility).toBe('unknown');
    expect(read.detail).not.toBe('');
  });

  test('a directory that is not a git checkout is unknown, not private', async () => {
    const read = await repoVisibility(scratch({}), { PATH: process.env.PATH });

    expect(read.visibility).toBe('unknown');
  });
});

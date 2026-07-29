import { describe, test, expect } from 'bun:test';
import type { Pin } from '../plugins/version-police';
import {
  versionPolice,
  analyzePin,
  cachedVersion,
  changedPins,
  evaluatePins,
  inlineAllow,
  isManifest,
  loadConfig,
  majorLag,
  matchesException,
  parsePins,
  parseVersion,
} from '../plugins/version-police';

const config = { enabled: true, exceptions: [] };
const mockCtx = { directory: '/tmp', worktree: '/tmp' } as any;

function pin(over: Partial<Pin> = {}): Pin {
  return { ecosystem: 'npm', name: 'react', version: '17.0.0', raw: '', inlineAllow: false, ...over };
}

describe('parsePins', () => {
  test('extracts npm deps and skips ranges/latest', () => {
    const content = JSON.stringify({
      dependencies: { react: '^17.0.0', 'is-latest': 'latest', linked: 'workspace:*' },
      devDependencies: { typescript: '5.3.3' },
    });
    const pins = parsePins('package.json', content);
    expect(pins.map((p) => p.name).sort()).toEqual(['react', 'typescript']);
    expect(pins.find((p) => p.name === 'react')!.version).toBe('17.0.0');
  });

  test('extracts Cargo deps only inside dependency sections', () => {
    const content = [
      '[package]',
      'name = "x"',
      'version = "1.2.3"',
      '',
      '[dependencies]',
      'serde = "0.9.0"',
      'tokio = { version = "0.2.0", features = ["full"] }',
    ].join('\n');
    const pins = parsePins('Cargo.toml', content);
    expect(pins.map((p) => `${p.name}@${p.version}`).sort()).toEqual(['serde@0.9.0', 'tokio@0.2.0']);
  });

  test('extracts pypi pins from requirements and pyproject', () => {
    expect(parsePins('requirements.txt', 'django==3.2.0\nflask>=2.0').map((p) => p.name)).toEqual([
      'django',
    ]);
    const poetry = '[tool.poetry.dependencies]\npython = "^3.11"\nrequests = "^2.20.0"';
    expect(parsePins('pyproject.toml', poetry).map((p) => p.name)).toEqual(['requests']);
  });

  test('extracts docker image tags, skipping non-semver tags', () => {
    const content = 'FROM node:18.19.0-alpine AS build\nFROM nginx:latest';
    const pins = parsePins('Dockerfile', content);
    expect(pins.map((p) => `${p.name}@${p.version}`)).toEqual(['node@18.19.0']);
  });

  test('extracts go module versions', () => {
    const content = 'require (\n\tgithub.com/gin-gonic/gin v1.7.0\n)';
    const pins = parsePins('go.mod', content);
    expect(pins[0]).toMatchObject({ name: 'github.com/gin-gonic/gin', version: '1.7.0' });
  });
});

describe('isManifest', () => {
  test('recognises supported manifests and rejects others', () => {
    for (const f of ['package.json', 'Cargo.toml', 'pyproject.toml', 'requirements-dev.txt', 'Dockerfile', 'docker-compose.yml', 'go.mod']) {
      expect(isManifest(f)).toBe(true);
    }
    expect(isManifest('src/index.ts')).toBe(false);
    expect(isManifest('README.md')).toBe(false);
  });
});

describe('changedPins', () => {
  test('returns only new or version-changed pins', () => {
    const oldC = JSON.stringify({ dependencies: { react: '17.0.0', lodash: '4.17.21' } });
    const newC = JSON.stringify({ dependencies: { react: '18.0.0', lodash: '4.17.21', axios: '1.0.0' } });
    const changed = changedPins('package.json', newC, oldC).map((p) => p.name).sort();
    expect(changed).toEqual(['axios', 'react']); // lodash unchanged is skipped
  });
});

describe('inlineAllow', () => {
  test('matches on same line, unnamed, and named package', () => {
    expect(inlineAllow('serde = "0.9" # version-police: allow', '', 'serde')).toBe(true);
    expect(inlineAllow('serde = "0.9" # version-police: allow serde -- legacy', '', 'serde')).toBe(true);
    expect(inlineAllow('serde = "0.9"', '# version-police: allow serde', 'serde')).toBe(true);
  });
  test('does not match a different named package', () => {
    expect(inlineAllow('serde = "0.9" # version-police: allow tokio', '', 'serde')).toBe(false);
    expect(inlineAllow('serde = "0.9"', '', 'serde')).toBe(false);
  });
});

describe('matchesException', () => {
  test('exact and glob patterns', () => {
    expect(matchesException('react', ['react'])).toBe(true);
    expect(matchesException('@types/node', ['@types/*'])).toBe(true);
    expect(matchesException('react-dom', ['react'])).toBe(false);
  });
});

describe('version math', () => {
  test('parseVersion strips prefixes and prerelease', () => {
    expect(parseVersion('^1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('v2.0.0-rc1')).toEqual([2, 0, 0]);
  });
  test('majorLag', () => {
    expect(majorLag('17.0.0', '19.0.0')).toBe(2);
    expect(majorLag('4.17.20', '4.17.21')).toBe(0);
  });
});

describe('analyzePin', () => {
  test('blocks a pin one or more majors behind', () => {
    expect(analyzePin(pin({ version: '17.0.0' }), '19.0.0', config)).toBe('block');
  });
  test('warns on minor/patch lag', () => {
    expect(analyzePin(pin({ version: '4.17.20' }), '4.17.21', config)).toBe('warn');
  });
  test('ok when up to date', () => {
    expect(analyzePin(pin({ version: '19.0.0' }), '19.0.0', config)).toBe('ok');
  });
  test('fails open when latest is null (network failure)', () => {
    expect(analyzePin(pin({ version: '1.0.0' }), null, config)).toBe('ok');
  });
  test('inline allow overrides a stale major', () => {
    expect(analyzePin(pin({ version: '1.0.0', inlineAllow: true }), '9.0.0', config)).toBe('ok');
  });
  test('config exception overrides a stale major', () => {
    expect(analyzePin(pin({ version: '1.0.0' }), '9.0.0', { enabled: true, exceptions: ['react'] })).toBe('ok');
  });
});

describe('cachedVersion', () => {
  const now = 1_000_000_000_000;
  test('returns a fresh entry', () => {
    expect(cachedVersion({ 'npm:react': { v: '19.0.0', t: now } }, 'npm:react', now + 1000)).toBe('19.0.0');
  });
  test('returns null for a stale entry (>24h)', () => {
    expect(cachedVersion({ 'npm:react': { v: '19.0.0', t: now } }, 'npm:react', now + 25 * 3600_000)).toBeNull();
  });
  test('returns null when key absent', () => {
    expect(cachedVersion({}, 'npm:react', now)).toBeNull();
  });
});

describe('evaluatePins', () => {
  test('stale major is blocked', async () => {
    const { blocks, warns } = await evaluatePins([pin({ version: '17.0.0' })], async () => '19.0.0', config);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('react');
    expect(blocks[0]).toContain('19.0.0');
    expect(warns).toHaveLength(0);
  });

  test('minor lag warns only', async () => {
    const { blocks, warns } = await evaluatePins([pin({ version: '4.17.20', name: 'lodash' })], async () => '4.17.21', config);
    expect(blocks).toHaveLength(0);
    expect(warns).toHaveLength(1);
  });

  test('network failure fails open (no blocks/warns)', async () => {
    const { blocks, warns } = await evaluatePins([pin({ version: '1.0.0' })], async () => null, config);
    expect(blocks).toHaveLength(0);
    expect(warns).toHaveLength(0);
  });

  test('inline-allow pin is skipped without a lookup', async () => {
    let looked = false;
    const { blocks } = await evaluatePins([pin({ version: '1.0.0', inlineAllow: true })], async () => {
      looked = true;
      return '9.0.0';
    }, config);
    expect(blocks).toHaveLength(0);
    expect(looked).toBe(false);
  });

  test('config exception pin is skipped without a lookup', async () => {
    let looked = false;
    const { blocks } = await evaluatePins([pin({ version: '1.0.0' })], async () => {
      looked = true;
      return '9.0.0';
    }, { enabled: true, exceptions: ['react'] });
    expect(blocks).toHaveLength(0);
    expect(looked).toBe(false);
  });

  test('cache-hit path: getLatest served from an in-memory cache blocks a stale major', async () => {
    const cache = { 'npm:react': { v: '19.0.0', t: Date.now() } };
    const getLatest = async (p: Pin) => cachedVersion(cache, `${p.ecosystem}:${p.name}`, Date.now());
    const { blocks } = await evaluatePins([pin({ version: '16.0.0' })], getLatest, config);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('behind latest 19.0.0');
  });
});

describe('plugin hook', () => {
  test('ignores non edit/write tools', async () => {
    const hooks = await versionPolice(mockCtx);
    const input = { tool: 'bash', sessionID: 't', callID: 't' };
    const output = { args: { command: 'ls' } };
    expect(hooks['tool.execute.before']!(input, output)).resolves.toBeUndefined();
  });

  test('ignores writes to non-manifest files', async () => {
    const hooks = await versionPolice(mockCtx);
    const input = { tool: 'write', sessionID: 't', callID: 't' };
    const output = { args: { filePath: '/tmp/index.ts', content: 'const x = 1' } };
    expect(hooks['tool.execute.before']!(input, output)).resolves.toBeUndefined();
  });

  test('disabled via AGENTKIT_SKIP_HOOKS is a no-op', async () => {
    const prev = process.env.AGENTKIT_SKIP_HOOKS;
    process.env.AGENTKIT_SKIP_HOOKS = 'version-police';
    try {
      const hooks = await versionPolice(mockCtx);
      const input = { tool: 'write', sessionID: 't', callID: 't' };
      const output = { args: { filePath: '/tmp/package.json', content: '{"dependencies":{"react":"1.0.0"}}' } };
      await expect(hooks['tool.execute.before']!(input, output)).resolves.toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.AGENTKIT_SKIP_HOOKS;
      else process.env.AGENTKIT_SKIP_HOOKS = prev;
    }
  });
});

describe('loadConfig', () => {
  test('returns defaults when no config present', () => {
    const cfg = loadConfig();
    expect(cfg).toHaveProperty('enabled');
    expect(cfg).toHaveProperty('exceptions');
  });
});

import { afterAll, describe, test, expect } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(import.meta.dir);
const installScript = join(repoRoot, 'install.sh');
// A global install intentionally installs and builds dependency-bearing
// skills; a cold-cache runner has crossed 60s doing it.
const globalInstallTimeoutMs = 120_000;

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function writeAgentkitConfig(home: string, contents: string): void {
  mkdirSync(join(home, '.config', 'agentkit'), { recursive: true });
  writeFileSync(join(home, '.config', 'agentkit', 'config.yaml'), contents);
}

function runInstall(home: string, extraArgs: string[], extraEnv: Record<string, string>) {
  return spawnSync('bash', [installScript, '--global', '--no-session-scope', ...extraArgs], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      AGENTKIT_HOME: join(home, '.agentkit'),
      ...extraEnv,
    },
    encoding: 'utf-8',
    timeout: globalInstallTimeoutMs,
  });
}

// The one install in the whole suite that resolves and builds real skill
// dependencies, so a dependency that stops resolving still fails something.
function runGlobalInstallWithSkillDeps(home: string) {
  return runInstall(home, [], {});
}

// Everywhere else pins prompt splicing, which the dependency step does not
// touch, and paying for it once per install is most of these tests' runtime.
function runGlobalInstall(home: string, extraArgs: string[] = []) {
  return runInstall(home, extraArgs, { AGENTKIT_SKIP_SKILL_DEPS: '1' });
}

describe('global prompt installation', () => {
  test('wires every instructions file into Codex, Claude, and OpenCode idempotently', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-home-'));

    try {
      const codexDir = join(home, '.codex');
      const claudeDir = join(home, '.claude');
      const opencodeDir = join(home, '.config', 'opencode');

      mkdirSync(codexDir, { recursive: true });
      mkdirSync(claudeDir, { recursive: true });
      mkdirSync(opencodeDir, { recursive: true });
      writeAgentkitConfig(home, 'resource-police:\n  enabled: true\n');
      writeFileSync(
        join(codexDir, 'config.toml'),
        'model = "gpt-5.5"\nmodel_reasoning_effort = "xhigh"\n',
      );
      writeFileSync(
        join(claudeDir, 'CLAUDE.md'),
        '# Existing Claude Instructions\n\nKeep this line.\n',
      );
      writeFileSync(
        join(opencodeDir, 'opencode.json'),
        JSON.stringify(
          {
            $schema: 'https://opencode.ai/config.json',
            plugin: ['oh-my-openagent@latest'],
          },
          null,
          2,
        ),
      );

      for (let i = 0; i < 2; i += 1) {
        const result = runGlobalInstallWithSkillDeps(home);
        expect(result.status, result.stderr.toString()).toBe(0);
      }

      // Canonical files live under ~/.agentkit; ~/.agents gets per-name links.
      const antiGlaze = join(home, '.agentkit', 'instructions', 'anti-glaze.md');
      const codingDiscipline = join(
        home,
        '.agentkit',
        'instructions',
        'coding-discipline.md',
      );
      const collaborationVisibility = join(
        home,
        '.agentkit',
        'instructions',
        'collaboration-visibility.md',
      );
      const resourceSafety = join(
        home,
        '.agentkit',
        'instructions',
        'resource-safety.md',
      );
      const reviewDiscipline = join(
        home,
        '.agentkit',
        'instructions',
        'review-discipline.md',
      );
      expect(existsSync(antiGlaze)).toBe(true);
      expect(existsSync(codingDiscipline)).toBe(true);
      expect(existsSync(collaborationVisibility)).toBe(true);
      expect(existsSync(resourceSafety)).toBe(true);
      // Opt-in since it is prompt weight on every session, not just on the
      // sessions that merge something.
      expect(existsSync(reviewDiscipline)).toBe(false);
      expect(existsSync(join(home, '.grok', 'rules', 'review-discipline.md'))).toBe(false);
      const agentsAntiGlaze = join(home, '.agents', 'instructions', 'anti-glaze.md');
      expect(lstatSync(agentsAntiGlaze).isSymbolicLink()).toBe(true);
      expect(readlinkSync(agentsAntiGlaze)).toBe(antiGlaze);
      const grokAntiGlaze = join(home, '.grok', 'rules', 'anti-glaze.md');
      expect(lstatSync(grokAntiGlaze).isSymbolicLink()).toBe(true);
      expect(readlinkSync(grokAntiGlaze)).toBe(antiGlaze);
      expect(readFileSync(antiGlaze, 'utf-8')).toContain(
        'agentkit:anti-glaze:start',
      );
      expect(readFileSync(codingDiscipline, 'utf-8')).toContain(
        'agentkit:coding-discipline:start',
      );
      expect(readFileSync(collaborationVisibility, 'utf-8')).toContain(
        'agentkit:collaboration-visibility:start',
      );
      expect(readFileSync(collaborationVisibility, 'utf-8')).toContain(
        'Codex and OpenCode terminal or TUI chats',
      );
      expect(readFileSync(collaborationVisibility, 'utf-8')).toContain(
        'Neutron Core web UI',
      );
      expect(readFileSync(collaborationVisibility, 'utf-8')).toContain(
        'When Mermaid support is unknown, use ASCII',
      );
      expect(readFileSync(resourceSafety, 'utf-8')).toContain(
        'agentkit:resource-safety:start',
      );

      const codexConfig = readFileSync(join(codexDir, 'config.toml'), 'utf-8');
      expect(codexConfig).toContain('model = "gpt-5.5"');
      expect(codexConfig).toContain('developer_instructions = """');
      expect(codexConfig).not.toContain('model_instructions_file');
      expect(countOccurrences(codexConfig, 'agentkit:anti-glaze:start')).toBe(
        1,
      );
      expect(
        countOccurrences(codexConfig, 'agentkit:coding-discipline:start'),
      ).toBe(1);
      expect(
        countOccurrences(
          codexConfig,
          'agentkit:collaboration-visibility:start',
        ),
      ).toBe(1);
      expect(
        countOccurrences(codexConfig, 'agentkit:resource-safety:start'),
      ).toBe(1);

      const claudeInstructions = readFileSync(
        join(claudeDir, 'CLAUDE.md'),
        'utf-8',
      );
      expect(claudeInstructions).toContain('Keep this line.');
      expect(
        countOccurrences(claudeInstructions, 'agentkit:coding-discipline:start'),
      ).toBe(1);
      expect(claudeInstructions).toContain(
        'Anti-Glaze Global Agent Instructions',
      );
      expect(claudeInstructions).toContain('Coding Discipline');
      expect(claudeInstructions).toContain('Collaboration Visibility');
      expect(claudeInstructions).toContain('Resource-safe Execution');
      expect(
        countOccurrences(claudeInstructions, 'agentkit:anti-glaze:start'),
      ).toBe(1);
      expect(
        countOccurrences(claudeInstructions, 'agentkit:coding-discipline:start'),
      ).toBe(1);
      expect(
        countOccurrences(
          claudeInstructions,
          'agentkit:collaboration-visibility:start',
        ),
      ).toBe(1);
      expect(
        countOccurrences(claudeInstructions, 'agentkit:resource-safety:start'),
      ).toBe(1);

      const opencodeConfig = JSON.parse(
        readFileSync(join(opencodeDir, 'opencode.json'), 'utf-8'),
      );
      expect(opencodeConfig.plugin).toEqual(['oh-my-openagent@latest']);
      expect(opencodeConfig.instructions).toContain(antiGlaze);
      expect(opencodeConfig.instructions).toContain(codingDiscipline);
      expect(opencodeConfig.instructions).toContain(collaborationVisibility);
      expect(opencodeConfig.instructions).toContain(resourceSafety);
      expect(
        opencodeConfig.instructions.filter(
          (entry: string) => entry === antiGlaze,
        ).length,
      ).toBe(1);
      expect(
        opencodeConfig.instructions.filter(
          (entry: string) => entry === codingDiscipline,
        ).length,
      ).toBe(1);
      expect(
        opencodeConfig.instructions.filter(
          (entry: string) => entry === collaborationVisibility,
        ).length,
      ).toBe(1);
      expect(
        opencodeConfig.instructions.filter(
          (entry: string) => entry === resourceSafety,
        ).length,
      ).toBe(1);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, 2 * globalInstallTimeoutMs);

  test('replaces an existing embedded Codex prompt with the managed block', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-home-'));

    try {
      const codexDir = join(home, '.codex');
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(
        join(codexDir, 'config.toml'),
        [
          'model = "gpt-5.5"',
          'developer_instructions = """',
          '# Anti-Glaze Global Agent Instructions',
          'Accuracy is the success metric, not user approval.',
          '"""',
          '',
        ].join('\n'),
      );

      const result = runGlobalInstall(home);
      expect(result.status, result.stderr.toString()).toBe(0);

      const codexConfig = readFileSync(join(codexDir, 'config.toml'), 'utf-8');
      expect(codexConfig).toContain('developer_instructions = """');
      expect(codexConfig).not.toContain('model_instructions_file');
      expect(codexConfig).toContain('agentkit:anti-glaze:start');
      expect(
        countOccurrences(codexConfig, 'Anti-Glaze Global Agent Instructions'),
      ).toBe(1);
      expect(countOccurrences(codexConfig, 'agentkit:anti-glaze:start')).toBe(
        1,
      );
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);
});

describe('the advisory review instruction is opt-in', () => {
  // It is 25 lines spliced into every prompt on every session, whether or not the
  // work will merge anything. Being able to run without it is the point: the kit
  // is explicit, so a plain re-install removes it again.
  const promptPath = (home: string) => join(home, '.claude', 'CLAUDE.md');
  const instructionPath = (home: string) =>
    join(home, '.agentkit', 'instructions', 'review-discipline.md');

  // Two of these read a plain default install without touching it, and the
  // install is the whole cost. The ones that re-install or deselect still get
  // their own home, because they change what the next assertion would see.
  let plainInstall: string | null = null;
  function defaultInstall(): string {
    if (plainInstall) return plainInstall;
    const home = mkdtempSync(join(tmpdir(), 'agentkit-review-flag-'));
    const result = runGlobalInstall(home);
    expect(result.status, result.stderr).toBe(0);
    plainInstall = home;
    return home;
  }
  afterAll(() => {
    if (plainInstall) rmSync(plainInstall, { recursive: true, force: true });
  });

  test('--with advisory-review installs it and splices it into the prompt', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-review-flag-'));

    try {
      const result = runGlobalInstall(home, ['--with', 'advisory-review']);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(instructionPath(home))).toBe(true);
      expect(readFileSync(promptPath(home), 'utf-8')).toContain(
        'agentkit:review-discipline:start',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, globalInstallTimeoutMs);

  test('a default install leaves it out of the prompt entirely', () => {
    const home = defaultInstall();

    expect(existsSync(instructionPath(home))).toBe(false);
    expect(readFileSync(promptPath(home), 'utf-8')).not.toContain(
      'agentkit:review-discipline:start',
    );
  }, globalInstallTimeoutMs);

  // Presence without a recorded selection is not consent, so deselecting has to
  // take the instruction back out of the prompt rather than leave it behind.
  test('re-installing without it removes the instruction and the prompt block', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-review-flag-'));

    try {
      expect(runGlobalInstall(home, ['--with', 'advisory-review']).status).toBe(0);
      expect(existsSync(instructionPath(home))).toBe(true);

      const second = runGlobalInstall(home, ['--without', 'advisory-review']);
      expect(second.status, second.stderr).toBe(0);
      expect(existsSync(instructionPath(home))).toBe(false);
      expect(readFileSync(promptPath(home), 'utf-8')).not.toContain(
        'agentkit:review-discipline:start',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, globalInstallTimeoutMs);

  test('the other core instructions are unaffected', () => {
    const prompt = readFileSync(promptPath(defaultInstall()), 'utf-8');
    for (const name of ['anti-glaze', 'coding-discipline', 'collaboration-visibility']) {
      expect(prompt).toContain(`agentkit:${name}:start`);
    }
  }, globalInstallTimeoutMs);
});

describe('the resource-safety instruction follows the enforcement config', () => {
  const promptPath = (home: string) => join(home, '.claude', 'CLAUDE.md');
  const instructionPath = (home: string) =>
    join(home, '.agentkit', 'instructions', 'resource-safety.md');

  test('a default install leaves it out; enabling installs it; disabling removes it', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-resource-config-'));

    try {
      expect(runGlobalInstall(home).status).toBe(0);
      expect(existsSync(instructionPath(home))).toBe(false);
      expect(readFileSync(promptPath(home), 'utf-8')).not.toContain(
        'agentkit:resource-safety:start',
      );

      writeAgentkitConfig(home, 'delegation-police:\n  enabled: true\n');
      expect(runGlobalInstall(home).status).toBe(0);
      expect(existsSync(instructionPath(home))).toBe(true);
      expect(readFileSync(promptPath(home), 'utf-8')).toContain(
        'agentkit:resource-safety:start',
      );

      writeAgentkitConfig(home, 'delegation-police:\n  enabled: false\n');
      expect(runGlobalInstall(home).status).toBe(0);
      expect(existsSync(instructionPath(home))).toBe(false);
      expect(readFileSync(promptPath(home), 'utf-8')).not.toContain(
        'agentkit:resource-safety:start',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 3 * globalInstallTimeoutMs);
});

import { describe, test, expect } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(import.meta.dir);
const installScript = join(repoRoot, 'install.sh');

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function runGlobalInstall(home: string) {
  return spawnSync('bash', [installScript, '--global'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
    },
    encoding: 'utf-8',
  });
}

describe('global prompt installation', () => {
  test('wires the shared prompt into Codex, Claude, and OpenCode idempotently', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-home-'));

    try {
      const codexDir = join(home, '.codex');
      const claudeDir = join(home, '.claude');
      const opencodeDir = join(home, '.config', 'opencode');

      mkdirSync(codexDir, { recursive: true });
      mkdirSync(claudeDir, { recursive: true });
      mkdirSync(opencodeDir, { recursive: true });
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
        const result = runGlobalInstall(home);
        expect(result.status, result.stderr.toString()).toBe(0);
      }

      const installedPrompt = join(
        home,
        '.agents',
        'instructions',
        'anti-glaze.md',
      );
      expect(existsSync(installedPrompt)).toBe(true);
      expect(readFileSync(installedPrompt, 'utf-8')).toContain(
        'agentkit:anti-glaze:start',
      );

      const codexConfig = readFileSync(join(codexDir, 'config.toml'), 'utf-8');
      expect(codexConfig).toContain('model = "gpt-5.5"');
      expect(codexConfig).toContain('developer_instructions = """');
      expect(codexConfig).toContain('agentkit:anti-glaze:start');
      expect(codexConfig).not.toContain('model_instructions_file');
      expect(countOccurrences(codexConfig, 'agentkit:anti-glaze:start')).toBe(
        1,
      );

      const claudeInstructions = readFileSync(
        join(claudeDir, 'CLAUDE.md'),
        'utf-8',
      );
      expect(claudeInstructions).toContain('Keep this line.');
      expect(claudeInstructions).toContain(
        'Anti-Glaze Global Agent Instructions',
      );
      expect(
        countOccurrences(claudeInstructions, 'agentkit:anti-glaze:start'),
      ).toBe(1);

      const opencodeConfig = JSON.parse(
        readFileSync(join(opencodeDir, 'opencode.json'), 'utf-8'),
      );
      expect(opencodeConfig.plugin).toEqual(['oh-my-openagent@latest']);
      expect(opencodeConfig.instructions).toContain(installedPrompt);
      expect(
        opencodeConfig.instructions.filter(
          (entry: string) => entry === installedPrompt,
        ).length,
      ).toBe(1);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

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
  });
});

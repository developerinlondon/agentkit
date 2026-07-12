import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const repoRoot = dirname(import.meta.dir);
const skillDir = join(repoRoot, 'skills', 'resource-safe-execution');

describe('resource-safe-execution assets', () => {
  test('ships a discoverable skill with OpenAI interface metadata', () => {
    const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skill).toContain('name: resource-safe-execution');
    expect(skill).toContain('bounded-run');
    expect(skill).not.toContain('`$CLAUDE_PLUGIN_ROOT/tools/bounded-run`');
    expect(existsSync(join(skillDir, 'agents', 'openai.yaml'))).toBe(true);
    const metadata = readFileSync(join(skillDir, 'agents', 'openai.yaml'), 'utf-8');
    expect(metadata).toContain('display_name: "Resource-safe Execution"');
    expect(metadata).toContain('$resource-safe-execution');
  });

  test('global instruction requires deterministic containment and preserves live infrastructure', () => {
    const instruction = readFileSync(
      join(repoRoot, 'instructions', 'resource-safety.md'),
      'utf-8',
    );
    expect(instruction).toContain('agentkit:resource-safety:start');
    expect(instruction).toContain('bounded-run');
    expect(instruction).toContain('Never run resource-intensive');
    expect(instruction).toContain('Do not restart');
    expect(instruction).toContain('delegated workloads');
    expect(instruction).toContain('defense-in-depth');
    expect(instruction).toContain('host service resource limits');
  });

  test('Claude plugin mirrors stay byte-identical to their source assets', () => {
    const pluginRoot = join(repoRoot, 'plugins-cc', 'agentkit');
    for (const [source, mirror] of [
      ['hooks/claude/resource-police.sh', 'hooks/resource-police.sh'],
      ['skills/resource-safe-execution/SKILL.md', 'skills/resource-safe-execution/SKILL.md'],
      ['tools/bounded-run', 'tools/bounded-run'],
    ]) {
      expect(readFileSync(join(pluginRoot, mirror), 'utf-8')).toBe(
        readFileSync(join(repoRoot, source), 'utf-8'),
      );
    }
  });
});

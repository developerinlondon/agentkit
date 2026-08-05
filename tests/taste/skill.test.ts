import { YAML } from 'bun';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENFORCEMENTS, SCOPES, STRENGTHS } from '../../skills/taste/scripts/lint.ts';

const repoRoot = join(import.meta.dir, '..', '..');

function read(...parts: string[]): string {
  return readFileSync(join(repoRoot, ...parts), 'utf-8');
}

const skill = read('skills', 'taste', 'SKILL.md');
const reference = read('skills', 'taste', 'references', 'format.md');
const example = read('config.example.yaml');

describe('the taste skill and its contract agree', () => {
  test('the skill declares the name the installer keys on', () => {
    const front = YAML.parse(/^---\n([\s\S]*?)\n---/.exec(skill)?.[1] ?? '') as {
      name?: string;
      description?: string;
    };
    expect(front.name).toBe('taste');
    expect(front.description).toContain('from now on');
  });

  test('every value the lint accepts is documented in the format reference', () => {
    for (const value of [...SCOPES, ...STRENGTHS, ...ENFORCEMENTS]) {
      expect(reference, `format.md documents ${value}`).toContain(`\`${value}\``);
    }
  });

  test('the config keys the skill reads ship in config.example.yaml, both on', () => {
    const config = YAML.parse(example) as { taste?: Record<string, unknown> };
    expect(config.taste).toEqual({ enabled: true, learning: true });
    expect(skill).toContain('taste.enabled');
    expect(skill).toContain('taste.learning');
    // Both ends of the fallback chain: a skill that read only the user config
    // would ignore the repository's own settings, which is where a project's
    // opt-out lives.
    expect(skill).toContain('.agentkit/config.yaml');
    expect(skill).toContain('~/.config/agentkit/config.yaml');
  });

  // The hook now exists, so the honest sentence changed direction: prose that
  // still said block was inert would understate enforcement the same way the
  // phase-1 prose would have overstated it.
  test('the skill describes block as the hook that performs it', () => {
    expect(skill).not.toContain('`block` behaves exactly like `check`');
    expect(skill).toContain('`taste-police`');
    expect(skill).toContain('UNCHECKED');
  });

  // Every edge the hook has, said in the words an agent answers with. The skill
  // is what a session reads when someone asks why a block did or did not fire.
  test.each([
    ['the override is named by the taste', 'that taste\'s named variable'],
    ['off-reading values do not disable it', 'do not count'],
    ['a malformed taste is not contagious', 'takes nothing else down with it'],
    ['an unrunnable hook allows', 'refuses on its own uncertainty'],
    ['the bounds are stated', '200 characters'],
  ])('the skill carries the hook behaviour: %s', (_behaviour, phrase) => {
    expect(skill.includes(phrase), `SKILL.md must say: ${phrase}`).toBe(true);
  });

  // The skill is the whole mechanism in this phase: nothing executes these rules,
  // so a behaviour silently dropped from the prose is a behaviour that stops
  // happening. Each entry is a decision the design settled, bound to the words
  // that carry it.
  test.each([
    ['precedence resolves in one direction', 'project > external > user > kit'],
    ['a higher scope replaces rather than merges', 'replaces the lower one'],
    ['dedupe happens before anything is written', '**2. Dedupe before writing anything.**'],
    ['a one-off leaves the file alone', '**The file is not touched.**'],
    ['a durable change supersedes in place', 'Supersede the taste **in place**'],
    ['no second file on the same topic', '`release-tier-v2.md`'],
    ['git history is the archive, not a v2 file', 'git history is the archive'],
    ['contradicting a require taste asks first', '**ask outright**'],
    ['the confirm names both readings', 'one-off, or change the taste?'],
    ['a prefer taste updates and says so', 'update it and say that you did'],
    // Asserted on the boolean rather than the document: toContain reports the
    // whole of SKILL.md as the received value, burying the one phrase that went
    // missing under the ten kilobytes that did not.
  ])('the skill still carries the behaviour: %s', (_behaviour, phrase) => {
    expect(skill.includes(phrase), `SKILL.md must still say: ${phrase}`).toBe(true);
  });

  test('the routing heuristic keeps an unclear correction out of the public set', () => {
    expect(skill).toContain('the private central set, as the safe default');
    expect(skill).toContain('owner-approved');
  });
});

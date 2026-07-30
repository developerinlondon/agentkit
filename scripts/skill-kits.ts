import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SkillKit {
  id: string;
  description: string;
  explicit: boolean;
}

export interface SkillKitManifest {
  kits: SkillKit[];
  membership: Record<string, string>;
}

export const DEFAULT_KIT = 'core';

export function parseSkillKits(contents: string): SkillKitManifest {
  const kits: SkillKit[] = [];
  // Null prototype: a skill named toString/constructor must hit the manifest,
  // not Object.prototype — bash has no such collision, so the readers diverge.
  const membership: Record<string, string> = Object.create(null);

  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const [first, second, ...rest] = trimmed.split(/\s+/);
    if (first === 'kit') {
      if (!second) throw new Error(`kit record without an id: ${trimmed}`);
      kits.push({ id: second, description: rest.join(' '), explicit: false });
      continue;
    }
    if (first === 'explicit') {
      if (!second) throw new Error(`explicit record without a kit id: ${trimmed}`);
      const target = kits.find((k) => k.id === second);
      if (!target) throw new Error(`explicit marker for undeclared kit: ${second}`);
      target.explicit = true;
      continue;
    }
    if (!first || !second) throw new Error(`membership record without a kit: ${trimmed}`);
    // Resolved first-match by lib/skill-kits.sh and last-match here, so a
    // duplicate would make the installer and this reader ship different sets.
    if (first in membership) {
      throw new Error(`manifest names more than one kit for: ${first}`);
    }
    membership[first] = second;
  }

  return { kits, membership };
}

export function readSkillKits(repoRoot: string): SkillKitManifest {
  return parseSkillKits(readFileSync(join(repoRoot, 'skills', 'KITS'), 'utf-8'));
}

export function kitOf(manifest: SkillKitManifest, skill: string): string {
  return manifest.membership[skill] ?? DEFAULT_KIT;
}

// Mirrors kit_plugin_id in lib/skill-kits.sh.
export function pluginIdFor(kit: string): string {
  return kit === DEFAULT_KIT ? 'agentkit' : `agentkit-${kit}`;
}

// Mirrors kit_has_skills in lib/skill-kits.sh, fail-safe included: a skills
// tree with no skill dirs at all is a misread, never an empty answer.
export function kitHasSkills(
  manifest: SkillKitManifest,
  repoRoot: string,
  kit: string,
): boolean {
  if (kit === DEFAULT_KIT) return true;
  const dirs = readdirSync(join(repoRoot, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  if (dirs.length === 0) return true;
  return dirs.some((entry) => kitOf(manifest, entry.name) === kit);
}

export function skillsInKit(
  manifest: SkillKitManifest,
  repoRoot: string,
  kit: string,
): string[] {
  return readdirSync(join(repoRoot, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && kitOf(manifest, entry.name) === kit)
    .map((entry) => entry.name)
    .sort();
}

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SkillGroup {
  id: string;
  description: string;
}

export interface SkillGroupManifest {
  groups: SkillGroup[];
  membership: Record<string, string>;
}

export const DEFAULT_GROUP = 'core';

export function parseSkillGroups(contents: string): SkillGroupManifest {
  const groups: SkillGroup[] = [];
  // Null prototype: a skill named toString/constructor must hit the manifest,
  // not Object.prototype — bash has no such collision, so the readers diverge.
  const membership: Record<string, string> = Object.create(null);

  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const [first, second, ...rest] = trimmed.split(/\s+/);
    if (first === 'group') {
      if (!second) throw new Error(`group record without an id: ${trimmed}`);
      groups.push({ id: second, description: rest.join(' ') });
      continue;
    }
    if (!first || !second) throw new Error(`membership record without a group: ${trimmed}`);
    // Resolved first-match by lib/skill-groups.sh and last-match here, so a
    // duplicate would make the installer and this reader ship different sets.
    if (first in membership) {
      throw new Error(`manifest names more than one group for: ${first}`);
    }
    membership[first] = second;
  }

  return { groups, membership };
}

export function readSkillGroups(repoRoot: string): SkillGroupManifest {
  return parseSkillGroups(readFileSync(join(repoRoot, 'skills', 'GROUPS'), 'utf-8'));
}

export function groupOf(manifest: SkillGroupManifest, skill: string): string {
  return manifest.membership[skill] ?? DEFAULT_GROUP;
}

// Mirrors group_plugin_id in lib/skill-groups.sh.
export function pluginIdFor(group: string): string {
  return group === DEFAULT_GROUP ? 'agentkit' : `agentkit-${group}`;
}

export function skillsInGroup(
  manifest: SkillGroupManifest,
  repoRoot: string,
  group: string,
): string[] {
  return readdirSync(join(repoRoot, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && groupOf(manifest, entry.name) === group)
    .map((entry) => entry.name)
    .sort();
}

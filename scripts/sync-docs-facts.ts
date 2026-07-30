import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..');
const factsPath = join(repoRoot, 'docs', 'site', 'src', 'generated', 'kit-facts.json');

const MECHANISMS = {
  hook: { directory: join('hooks', 'claude'), suffix: '-police.sh' },
  plugin: { directory: 'plugins', suffix: '-police.ts' },
  codexPolicy: { directory: join('policies', 'codex'), suffix: '-police.rules' },
  claudePlugin: {
    directory: join('plugins-cc', 'agentkit', 'hooks'),
    suffix: '-police.sh',
  },
} as const;

type Mechanism = keyof typeof MECHANISMS;

export interface PoliceUnit {
  name: string;
  mechanisms: Mechanism[];
}

export interface SkillFact {
  name: string;
  group: string;
  explicit: boolean;
  description: string;
}

export interface GroupFact {
  id: string;
  description: string;
  explicit: boolean;
}

export interface KitFacts {
  units: PoliceUnit[];
  groups: GroupFact[];
  skills: SkillFact[];
  tools: string[];
}

function listDirectory(relative: string, root: string): string[] {
  try {
    return readdirSync(join(root, relative), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function collectUnits(root: string): PoliceUnit[] {
  const found = new Map<string, Set<Mechanism>>();

  for (const [mechanism, { directory, suffix }] of Object.entries(MECHANISMS)) {
    for (const file of listDirectory(directory, root)) {
      if (!file.endsWith(suffix)) continue;
      const name = file.slice(0, -suffix.length);
      if (!found.has(name)) found.set(name, new Set());
      found.get(name)?.add(mechanism as Mechanism);
    }
  }

  return [...found.entries()]
    .map(([name, mechanisms]) => ({
      name,
      mechanisms: (Object.keys(MECHANISMS) as Mechanism[]).filter((m) => mechanisms.has(m)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

// The reader mirrors lib/ and the TypeScript installer: `group` declares,
// `explicit` marks consent-gated, a bare pair assigns, and anything unassigned
// belongs to `core`. A second reader that disagreed would be a silent lie.
function readGroups(root: string): { groups: GroupFact[]; membership: Map<string, string> } {
  const source = readFileSync(join(root, 'skills', 'GROUPS'), 'utf-8');
  const declared = new Map<string, string>();
  const explicit = new Set<string>();
  const membership = new Map<string, string>();

  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const [first, second, ...rest] = line.split(/\s+/);
    if (first === 'group' && second) declared.set(second, rest.join(' '));
    else if (first === 'explicit' && second) explicit.add(second);
    else if (first && second) membership.set(first, second);
  }

  const groups = [...declared.entries()]
    .map(([id, description]) => ({ id, description, explicit: explicit.has(id) }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return { groups, membership };
}

function frontmatterDescription(skill: string, root: string): string {
  const source = readFileSync(join(root, 'skills', skill, 'SKILL.md'), 'utf-8');
  const match = /^---\n([\s\S]*?)\n---/.exec(source);
  if (!match) throw new Error(`skills/${skill}/SKILL.md has no frontmatter`);
  const description = /^description:\s*(.+)$/m.exec(match[1] ?? '');
  if (!description?.[1]) throw new Error(`skills/${skill}/SKILL.md has no description`);
  return description[1].trim();
}

function collectSkills(groups: GroupFact[], membership: Map<string, string>, root: string): SkillFact[] {
  const explicitGroups = new Set(groups.filter((group) => group.explicit).map((g) => g.id));

  return readdirSync(join(root, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const group = membership.get(entry.name) ?? 'core';
      return {
        name: entry.name,
        group,
        explicit: explicitGroups.has(group),
        description: frontmatterDescription(entry.name, root),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function collectFacts(root: string = repoRoot): KitFacts {
  const { groups, membership } = readGroups(root);

  return {
    units: collectUnits(root),
    groups,
    skills: collectSkills(groups, membership, root),
    tools: listDirectory('tools', root).sort(),
  };
}

export function serialise(facts: KitFacts): string {
  return `${JSON.stringify(facts, null, 2)}\n`;
}

export function committedFacts(): string {
  return readFileSync(factsPath, 'utf-8');
}

if (import.meta.main) {
  const fresh = serialise(collectFacts());

  if (process.argv.includes('--check')) {
    let committed = '';
    try {
      committed = committedFacts();
    } catch {
      console.error(`docs facts: ${factsPath} is missing — run scripts/sync-docs-facts.ts`);
      process.exit(1);
    }
    if (committed !== fresh) {
      console.error('docs facts: the committed tables disagree with the tree');
      console.error('  run: bun run scripts/sync-docs-facts.ts');
      process.exit(1);
    }
    const facts = collectFacts();
    console.log(
      `docs facts: ${facts.units.length} units, ${facts.skills.length} skills, ` +
        `${facts.groups.length} groups, ${facts.tools.length} tools`,
    );
  } else {
    writeFileSync(factsPath, fresh);
    console.log(`docs facts: wrote ${factsPath}`);
  }
}

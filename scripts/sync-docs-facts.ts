import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const repoRoot = join(import.meta.dir, '..');
const factsPath = join(repoRoot, 'docs', 'site', 'src', 'generated', 'kit-facts.json');

const MECHANISMS = {
  hook: { directory: join('hooks', 'claude'), suffix: '-police.sh' },
  plugin: { directory: 'plugins', suffix: '-police.ts' },
  codexPolicy: { directory: join('policies', 'codex'), suffix: '-police.rules' },
} as const;

const PLUGIN_HOOK_SUFFIX = '-police.sh';

type Mechanism = keyof typeof MECHANISMS;

export interface PoliceUnit {
  name: string;
  mechanisms: Mechanism[];
  // Which Claude Code plugin packages the hook, if any. This is distribution,
  // not a fourth mechanism: scripts/sync-cc-plugin.sh copies hooks/claude
  // verbatim, so a column of its own would read as extra enforcement.
  claudePlugins: string[];
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

export interface HookWiring {
  unit: string;
  event: string;
  matcher: string;
  timeout: number;
  // Present when the hook runs behind fail-closed-hook.sh, which denies the tool
  // call if the guard has not answered inside this many seconds. A guard that
  // times out silently would read as approval.
  failClosedBudget: number | null;
}

export interface KitFacts {
  units: PoliceUnit[];
  wiring: HookWiring[];
  groups: GroupFact[];
  skills: SkillFact[];
  tools: string[];
}

function listDirectories(relative: string, root: string): string[] {
  try {
    return readdirSync(join(root, relative), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
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

function collectPluginPackaging(root: string): Map<string, string[]> {
  const packaged = new Map<string, string[]>();

  for (const plugin of listDirectories('plugins-cc', root)) {
    for (const file of listDirectory(join('plugins-cc', plugin, 'hooks'), root)) {
      if (!file.endsWith(PLUGIN_HOOK_SUFFIX)) continue;
      const name = file.slice(0, -PLUGIN_HOOK_SUFFIX.length);
      packaged.set(name, [...(packaged.get(name) ?? []), plugin].sort());
    }
  }

  return packaged;
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

  const packaged = collectPluginPackaging(root);
  for (const name of packaged.keys()) {
    if (!found.has(name)) found.set(name, new Set());
  }

  return [...found.entries()]
    .map(([name, mechanisms]) => ({
      name,
      mechanisms: (Object.keys(MECHANISMS) as Mechanism[]).filter((m) => mechanisms.has(m)),
      claudePlugins: packaged.get(name) ?? [],
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

// scripts/sync-cc-plugin.sh copies hooks/claude into the plugins verbatim and its
// header forbids editing the copy. Any difference means a plugin ships
// enforcement that the documented source does not describe, so the tables would
// be describing the wrong file.
export function pluginHookDrift(root: string = repoRoot): string[] {
  const drifted: string[] = [];

  for (const plugin of listDirectories('plugins-cc', root)) {
    for (const file of listDirectory(join('plugins-cc', plugin, 'hooks'), root)) {
      if (!file.endsWith(PLUGIN_HOOK_SUFFIX)) continue;
      const source = join(root, 'hooks', 'claude', file);
      const copy = join(root, 'plugins-cc', plugin, 'hooks', file);
      try {
        if (readFileSync(source, 'utf-8') !== readFileSync(copy, 'utf-8')) {
          drifted.push(`${plugin}/${file}`);
        }
      } catch {
        drifted.push(`${plugin}/${file} (no hooks/claude source)`);
      }
    }
  }

  return drifted.sort();
}

// hooks/claude/settings.json is the wiring the harness actually reads. The header
// comments describe the same thing in prose and disagree with it in places, so
// the tables come from the JSON.
export function collectWiring(root: string = repoRoot): HookWiring[] {
  const path = join(root, 'hooks', 'claude', 'settings.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return [];
  }

  const hooks = (parsed as { hooks?: Record<string, unknown> }).hooks ?? {};
  const wiring: HookWiring[] = [];

  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const matcher = typeof group?.matcher === 'string' ? group.matcher : '';
      const entries = Array.isArray(group?.hooks) ? group.hooks : [];
      for (const entry of entries) {
        if (typeof entry?.command !== 'string') continue;
        const tokens = entry.command.split(/\s+/);
        const script = [...tokens].reverse().find((token: string) => token.endsWith('.sh'));
        if (!script?.endsWith(PLUGIN_HOOK_SUFFIX)) continue;
        const wrapper = tokens.findIndex((token: string) => token.endsWith('fail-closed-hook.sh'));
        const budget = wrapper === -1 ? null : Number(tokens[wrapper + 1]);
        wiring.push({
          unit: (script.split('/').pop() ?? '').slice(0, -PLUGIN_HOOK_SUFFIX.length),
          event,
          matcher,
          timeout: typeof entry.timeout === 'number' ? entry.timeout : 0,
          failClosedBudget: budget !== null && Number.isFinite(budget) ? budget : null,
        });
      }
    }
  }

  return wiring.sort((left, right) =>
    `${left.unit}${left.event}${left.matcher}`.localeCompare(
      `${right.unit}${right.event}${right.matcher}`,
    )
  );
}

export function collectFacts(root: string = repoRoot): KitFacts {
  const { groups, membership } = readGroups(root);

  return {
    units: collectUnits(root),
    wiring: collectWiring(root),
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

// Cutting a version freezes the tables that version described. Without this an
// archived page keeps rendering the current tree, so a frozen release silently
// describes whatever main looks like today.
export function freezeVersion(version: string, root: string = repoRoot): string {
  const target = join(root, 'docs', 'site', 'src', 'generated', 'frozen-facts', `${version}.json`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, serialise(collectFacts(root)));
  return target;
}

if (import.meta.main) {
  const freezeIndex = process.argv.indexOf('--freeze');
  if (freezeIndex !== -1) {
    const version = process.argv[freezeIndex + 1];
    if (!version) {
      console.error('docs facts: --freeze needs a version, e.g. --freeze 0.4');
      process.exit(1);
    }
    console.log(`docs facts: froze ${freezeVersion(version)}`);
    process.exit(0);
  }

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

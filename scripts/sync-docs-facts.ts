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
  kit: string;
  explicit: boolean;
  description: string;
}

export interface KitFact {
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
  kits: KitFact[];
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

// The reader mirrors lib/ and the TypeScript installer: `kit` declares,
// `explicit` marks consent-gated, a bare pair assigns, and anything unassigned
// belongs to `core`. A second reader that disagreed would be a silent lie.
function readKits(root: string): { kits: KitFact[]; membership: Map<string, string> } {
  const source = readFileSync(join(root, 'skills', 'KITS'), 'utf-8');
  const declared = new Map<string, string>();
  const explicit = new Set<string>();
  const membership = new Map<string, string>();

  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const [first, second, ...rest] = line.split(/\s+/);
    if (first === 'kit' && second) declared.set(second, rest.join(' '));
    else if (first === 'explicit' && second) explicit.add(second);
    else if (first && second) membership.set(first, second);
  }

  const kits = [...declared.entries()]
    .map(([id, description]) => ({ id, description, explicit: explicit.has(id) }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return { kits, membership };
}

function frontmatterDescription(skill: string, root: string): string {
  const source = readFileSync(join(root, 'skills', skill, 'SKILL.md'), 'utf-8');
  const match = /^---\n([\s\S]*?)\n---/.exec(source);
  if (!match) throw new Error(`skills/${skill}/SKILL.md has no frontmatter`);
  const frontmatter = match[1] ?? '';
  const head = /^description:[ \t]*(.*)$/m.exec(frontmatter);
  if (!head) throw new Error(`skills/${skill}/SKILL.md has no description`);
  const value = (head[1] ?? '').trim();
  // A block scalar (>-, |, …) keeps its text on the following indented lines;
  // taking the head line verbatim would record the indicator itself.
  if (!/^[>|][+-]?$/.test(value)) {
    if (!value) throw new Error(`skills/${skill}/SKILL.md has no description`);
    return value;
  }
  const lines: string[] = [];
  for (const line of frontmatter.slice(head.index + head[0].length).split('\n').slice(1)) {
    if (line.trim() === '') continue;
    if (!/^[ \t]/.test(line)) break;
    lines.push(line.trim());
  }
  if (lines.length === 0) throw new Error(`skills/${skill}/SKILL.md has no description`);
  return lines.join(' ');
}

function collectSkills(kits: KitFact[], membership: Map<string, string>, root: string): SkillFact[] {
  const explicitKits = new Set(kits.filter((kit) => kit.explicit).map((g) => g.id));

  return readdirSync(join(root, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const kit = membership.get(entry.name) ?? 'core';
      return {
        name: entry.name,
        kit,
        explicit: explicitKits.has(kit),
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

  for (const [event, kits] of Object.entries(hooks)) {
    if (!Array.isArray(kits)) continue;
    for (const kit of kits) {
      const matcher = typeof kit?.matcher === 'string' ? kit.matcher : '';
      const entries = Array.isArray(kit?.hooks) ? kit.hooks : [];
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
  const { kits, membership } = readKits(root);

  return {
    units: collectUnits(root),
    wiring: collectWiring(root),
    kits,
    skills: collectSkills(kits, membership, root),
    tools: listDirectory('tools', root).sort(),
  };
}

export function serialise(facts: KitFacts): string {
  return `${JSON.stringify(facts, null, 2)}\n`;
}

const README_MARKERS = {
  start: '<!-- generated:skills:start — edit skills/*/SKILL.md, then run scripts/sync-docs-facts.ts -->',
  end: '<!-- generated:skills:end -->',
} as const;

function firstSentence(text: string): string {
  const match = /^(.*?\.)\s/.exec(`${text} `);
  return (match?.[1] ?? text).trim();
}

function installCell(skill: SkillFact): string {
  if (skill.kit === 'core') return 'always';
  return skill.explicit ? `\`--with ${skill.kit}\` only` : `\`--with ${skill.kit}\``;
}

function markdownTable(header: string[], rows: string[][]): string {
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => (row[column] ?? '').length)));
  const line = (cells: string[]) =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join(' | ')} |`;
  return [
    line(header),
    `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`,
    ...rows.map(line),
  ].join('\n');
}

export function renderReadmeSkillsSection(facts: KitFacts): string {
  const rows = facts.skills.map((skill) => [
    `**${skill.name}**`,
    installCell(skill),
    firstSentence(skill.description),
  ]);
  return [
    README_MARKERS.start,
    '',
    markdownTable(['Skill', 'Install', 'Description'], rows),
    '',
    README_MARKERS.end,
  ].join('\n');
}

export function spliceReadme(readme: string, facts: KitFacts): string {
  const start = readme.indexOf(README_MARKERS.start);
  const end = readme.indexOf(README_MARKERS.end);
  if (start === -1 || end === -1 || end < start) {
    throw new Error('README.md is missing the generated:skills marker pair');
  }
  return readme.slice(0, start)
    + renderReadmeSkillsSection(facts)
    + readme.slice(end + README_MARKERS.end.length);
}

const readmePath = join(repoRoot, 'README.md');

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

  const facts = collectFacts();
  const fresh = serialise(facts);
  const readme = readFileSync(readmePath, 'utf-8');
  const freshReadme = spliceReadme(readme, facts);

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
    if (readme !== freshReadme) {
      console.error('docs facts: the README skills table disagrees with the tree');
      console.error('  run: bun run scripts/sync-docs-facts.ts');
      process.exit(1);
    }
    console.log(
      `docs facts: ${facts.units.length} units, ${facts.skills.length} skills, ` +
        `${facts.kits.length} kits, ${facts.tools.length} tools`,
    );
  } else {
    writeFileSync(factsPath, fresh);
    console.log(`docs facts: wrote ${factsPath}`);
    if (readme !== freshReadme) {
      writeFileSync(readmePath, freshReadme);
      console.log(`docs facts: wrote ${readmePath}`);
    }
  }
}

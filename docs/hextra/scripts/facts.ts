// Emits data/agentkit.json, which every reference table on the Hextra site
// renders from. The collection logic is imported rather than reimplemented: a
// second reader of the same tree is a second thing to drift.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectFacts, type KitFacts } from '../../../scripts/sync-docs-facts.ts';

const repoRoot = join(import.meta.dir, '..', '..', '..');
const dataPath = join(import.meta.dir, '..', 'data', 'agentkit.json');

const PLATFORM_DIRECTIVE = /^#[ \t]*agentkit:platforms[ \t]+(.+)$/m;
const DIRECTIVE_SCAN_LINES = 15;

interface ToolFact {
  name: string;
  platforms: string[];
}

interface ContextFact {
  name: string;
  file: string;
  globs: string | null;
}

interface EnrichedFacts extends KitFacts {
  toolDetails: ToolFact[];
  rules: ContextFact[];
  instructions: ContextFact[];
  plugins: string[];
  codexPolicies: string[];
  counts: Record<string, number>;
}

function files(relative: string): string[] {
  try {
    return readdirSync(join(repoRoot, relative), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

// The directive is metadata, not a filename convention: the installer reads the
// same first-15-lines window, so the table cannot claim a host the installer
// does not honour.
function platformsOf(relative: string): string[] {
  const head = readFileSync(join(repoRoot, relative), 'utf-8')
    .split('\n')
    .slice(0, DIRECTIVE_SCAN_LINES)
    .join('\n');
  const match = PLATFORM_DIRECTIVE.exec(head);
  if (!match) return ['portable'];
  return (match[1] ?? '').trim().split(/[\s,]+/).filter(Boolean);
}

function globsOf(relative: string): string | null {
  const source = readFileSync(join(repoRoot, relative), 'utf-8');
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source);
  if (!frontmatter) return null;
  const globs = /^globs:[ \t]*(.*)$/m.exec(frontmatter[1] ?? '');
  if (!globs) return null;
  return (globs[1] ?? '').trim().replace(/^["']|["']$/g, '') || null;
}

function contextFacts(directory: string): ContextFact[] {
  return files(directory)
    .filter((file) => file.endsWith('.md'))
    .map((file) => ({
      name: file.replace(/\.md$/, ''),
      file: `${directory}/${file}`,
      globs: globsOf(join(directory, file)),
    }));
}

export function enrich(): EnrichedFacts {
  const facts = collectFacts(repoRoot);
  const toolDetails = facts.tools.map((name) => ({
    name,
    platforms: platformsOf(join('tools', name)),
  }));
  const rules = contextFacts('rules');
  const instructions = contextFacts('instructions');
  const plugins = files('plugins').filter((file) => file.endsWith('.ts'));
  const codexPolicies = files(join('policies', 'codex')).filter((file) => file.endsWith('.rules'));

  return {
    ...facts,
    toolDetails,
    rules,
    instructions,
    plugins,
    codexPolicies,
    counts: {
      units: facts.units.length,
      skills: facts.skills.length,
      coreSkills: facts.skills.filter((skill) => skill.kit === 'core').length,
      kits: facts.kits.length,
      tools: facts.tools.length,
      rules: rules.length,
      instructions: instructions.length,
      plugins: plugins.length,
      codexPolicies: codexPolicies.length,
      wiring: facts.wiring.length,
    },
  };
}

if (import.meta.main) {
  const fresh = `${JSON.stringify(enrich(), null, 2)}\n`;

  if (process.argv.includes('--check')) {
    let committed = '';
    try {
      committed = readFileSync(dataPath, 'utf-8');
    } catch {
      console.error(`hextra facts: ${dataPath} is missing — run docs/hextra/scripts/facts.ts`);
      process.exit(1);
    }
    if (committed !== fresh) {
      console.error('hextra facts: the committed data disagrees with the tree');
      console.error('  run: bun run docs/hextra/scripts/facts.ts');
      process.exit(1);
    }
    console.log('hextra facts: data/agentkit.json matches the tree');
  } else {
    writeFileSync(dataPath, fresh);
    console.log(`hextra facts: wrote ${dataPath}`);
  }
}

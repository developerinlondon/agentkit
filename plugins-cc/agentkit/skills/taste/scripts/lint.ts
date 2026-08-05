import { YAML } from 'bun';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const REQUIRED_KEYS = ['name', 'provenance', 'scope', 'strength'];
const OPTIONAL_KEYS = ['category', 'enforce', 'rule'];
export const SCOPES = ['project', 'external', 'user'];
export const STRENGTHS = ['prefer', 'require'];
export const ENFORCEMENTS = ['advise', 'check', 'block'];
const RULE_KEYS = ['kind', 'match', 'remedy', 'override'];
const RULE_KINDS = ['command'];

// Unnumbered as well as kebab: position carries no meaning in a taste folder, so
// a leading number is a record's habit leaking into a dictionary.
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const SHELL_SUBSTITUTION = /\$\(|`/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

type Frontmatter = Record<string, unknown>;

function isRecord(value: unknown): value is Frontmatter {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return undefined;
}

// An absent key is the missing-required-keys error's business; reporting it here
// too would name one defect twice.
function enumError(key: string, value: unknown, allowed: string[]): string | undefined {
  if (value === undefined) return undefined;
  const text = scalar(value);
  if (text !== undefined && allowed.includes(text)) return undefined;
  return `${key}: ${JSON.stringify(value ?? null)} is not one of ${allowed.join(', ')}`;
}

function checkKeys(front: Frontmatter): string[] {
  const errors: string[] = [];
  const missing = REQUIRED_KEYS.filter((key) => scalar(front[key]) === undefined);
  if (missing.length > 0) {
    errors.push(`missing required frontmatter: ${missing.join(', ')}`);
  }
  const known = new Set([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);
  const unknown = Object.keys(front).filter((key) => !known.has(key)).sort();
  if (unknown.length > 0) {
    errors.push(`unknown frontmatter key: ${unknown.join(', ')} — accepted keys are ${
      [...known].sort().join(', ')
    }`);
  }
  return errors;
}

function checkName(front: Frontmatter, file: string): string[] {
  const name = scalar(front.name);
  if (name === undefined) return [];
  if (!NAME.test(name)) {
    return [`name: ${JSON.stringify(name)} must be kebab-case and unnumbered`];
  }
  const stem = basename(file).replace(/\.md$/, '');
  if (name !== stem) {
    return [`name: ${JSON.stringify(name)} does not match the filename — rename one of them`];
  }
  return [];
}

function checkEnums(front: Frontmatter): string[] {
  const errors = [
    enumError('scope', front.scope, SCOPES),
    enumError('strength', front.strength, STRENGTHS),
    enumError('enforce', front.enforce, ENFORCEMENTS),
  ];
  if (front.category !== undefined && scalar(front.category) === undefined) {
    errors.push('category must be a single value');
  }
  return errors.filter((error): error is string => error !== undefined);
}

function checkRuleFields(rule: Frontmatter): string[] {
  const errors: string[] = [];
  const unknown = Object.keys(rule).filter((key) => !RULE_KEYS.includes(key)).sort();
  if (unknown.length > 0) {
    errors.push(`unknown rule key: ${unknown.join(', ')} — a rule carries ${RULE_KEYS.join(', ')}`);
  }
  for (const key of ['kind', 'match', 'remedy']) {
    if (typeof rule[key] !== 'string') {
      errors.push(`rule.${key} must be a string — the rule is data, not structure`);
    }
  }
  if (typeof rule.kind === 'string' && !RULE_KINDS.includes(rule.kind)) {
    errors.push(`rule.kind: ${JSON.stringify(rule.kind)} is not one of ${RULE_KINDS.join(', ')}`);
  }
  if (typeof rule.match === 'string') {
    try {
      new RegExp(rule.match);
    } catch (error) {
      errors.push(`rule.match is not a valid regular expression: ${(error as Error).message}`);
    }
    if (SHELL_SUBSTITUTION.test(rule.match)) {
      errors.push(
        'rule.match carries a command substitution — a rule is data; escape it as \\$\\( to '
          + 'match those characters literally. A backtick cannot appear in a match at all.',
      );
    }
  }
  if (typeof rule.remedy === 'string' && SHELL_SUBSTITUTION.test(rule.remedy)) {
    errors.push(
      'rule.remedy carries a command substitution — a remedy is plain prose; name the command '
        + 'without backticks or $()',
    );
  }
  if (rule.override !== undefined && !ENV_NAME.test(String(rule.override))) {
    errors.push(`rule.override: ${JSON.stringify(rule.override)} must be an environment-variable name`);
  }
  return errors;
}

function checkRule(front: Frontmatter): string[] {
  const enforce = scalar(front.enforce) ?? 'advise';
  const hasRule = front.rule !== undefined;
  if (hasRule && enforce === 'advise') {
    return ['rule is only read at enforce: check or block — this taste is advise'];
  }
  if (!hasRule && enforce === 'block') {
    return ['enforce: block needs a rule — taste-police would have nothing to read'];
  }
  if (!hasRule) return [];
  if (!isRecord(front.rule)) return ['rule must be a block of kind, match, remedy, override'];
  return checkRuleFields(front.rule);
}

interface Inspection {
  name: string | undefined;
  errors: string[];
}

export function inspectTaste(file: string, contents: string): Inspection {
  const parts = FRONTMATTER.exec(contents);
  if (parts === null) {
    return { name: undefined, errors: ['no frontmatter — a taste opens with a --- block'] };
  }

  let front: unknown;
  try {
    front = YAML.parse(parts[1] as string);
  } catch (error) {
    return {
      name: undefined,
      errors: [`frontmatter does not parse: ${(error as Error).message}`],
    };
  }
  if (!isRecord(front)) {
    return { name: undefined, errors: ['frontmatter does not parse as a mapping of fields'] };
  }

  const errors = [
    ...checkKeys(front),
    ...checkName(front, file),
    ...checkEnums(front),
    ...checkRule(front),
  ];
  if ((parts[2] as string).trim() === '') {
    errors.push('body is empty — a taste states the preference, why, and how to apply it');
  }
  return { name: scalar(front.name), errors };
}

function tasteFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...tasteFiles(path));
    else if (entry.name.endsWith('.md')) found.push(path);
  }
  return found;
}

function duplicateNames(byName: Map<string, string[]>): string[] {
  return [...byName.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([name, paths]) => `duplicate name ${JSON.stringify(name)}: ${paths.sort().join(', ')}`);
}

export function lintTasteDirectory(dir: string): string[] {
  const errors: string[] = [];
  // Keyed on the parsed name rather than the name: line, because `"tier"` and
  // `tier # why` are the same identity to every reader of these files, and a
  // collision the lint cannot see is two tastes claiming one name.
  const byName = new Map<string, string[]>();

  for (const file of tasteFiles(dir).sort()) {
    const path = relative(dir, file);
    const inspection = inspectTaste(path, readFileSync(file, 'utf-8'));
    errors.push(...inspection.errors.map((error) => `${path}: ${error}`));
    if (inspection.name !== undefined) {
      byName.set(inspection.name, [...(byName.get(inspection.name) ?? []), path]);
    }
  }

  return [...errors, ...duplicateNames(byName)].sort();
}

export function countTastes(dir: string): number {
  return tasteFiles(dir).length;
}

function fail(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

if (import.meta.main) {
  const directories = process.argv.slice(2);
  if (directories.length === 0) fail('usage: lint.ts <tastes-directory>...', 2);

  let checked = 0;
  const errors: string[] = [];
  for (const dir of directories) {
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      fail(`no such directory: ${dir}`, 2);
    }
    checked += countTastes(dir);
    errors.push(...lintTasteDirectory(dir));
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
  console.log(`${checked} taste${checked === 1 ? '' : 's'} checked, all valid`);
}

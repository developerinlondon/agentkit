import { YAML } from 'bun';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { EXTERNAL_DIR, LEGACY_EXTERNAL_ROOT } from './layout.ts';
import { type RuleKind, ruleKeys, ruleKind, RULE_KINDS } from './rules/kinds.ts';
import { carriesSubstitution } from './rules/pattern.ts';

const REQUIRED_KEYS = ['name', 'provenance', 'scope', 'strength'];
const OPTIONAL_KEYS = ['category', 'enforce', 'rule'];
export const SCOPES = ['project', 'external', 'user'];
export const STRENGTHS = ['prefer', 'require'];
export const ENFORCEMENTS = ['advise', 'check', 'block'];

// `external` is read by position, not by name: it is the one directory at a
// tastes root that a sync writes and the resolver treats as a stack of sources.
const RESERVED = `${JSON.stringify(EXTERNAL_DIR)} is reserved — it names the subtree holding the `
  + 'snapshot of each declared source, at the root of a tastes tree and nowhere else';

// Unnumbered as well as kebab: position carries no meaning in a taste folder, so
// a leading number is a record's habit leaking into a dictionary.
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

type Frontmatter = Record<string, unknown>;

function isRecord(value: unknown): value is Frontmatter {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function scalar(value: unknown): string | undefined {
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
  if (name === EXTERNAL_DIR) return [`name: ${RESERVED}. Name the taste for its topic instead.`];
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

// The kind decides which keys mean anything, so an unknown kind names the ones
// agentkit implements instead of judging the rest of the block against a
// vocabulary nobody chose.
function checkKind(rule: Frontmatter, kind: RuleKind | undefined): string[] {
  if (typeof rule.kind !== 'string') return [];
  if (kind === undefined) {
    return [`rule.kind: ${JSON.stringify(rule.kind)} is not one of ${RULE_KINDS.join(', ')}`];
  }
  const keys = ruleKeys(kind);
  const unknown = Object.keys(rule).filter((key) => !keys.includes(key)).sort();
  if (unknown.length === 0) return [];
  return [
    `unknown rule key: ${unknown.join(', ')} — a rule of kind ${kind.name} carries `
      + keys.join(', '),
  ];
}

// Every value in the block is a string, which is what makes a rule data rather
// than structure. Which strings have to be there is the kind's business.
function stringFields(rule: Frontmatter): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(rule)) {
    if (typeof value === 'string') fields[key] = value;
  }
  return fields;
}

function checkRuleFields(rule: Frontmatter): string[] {
  const kind = typeof rule.kind === 'string' ? ruleKind(rule.kind) : undefined;
  const errors = checkKind(rule, kind);

  for (const key of ['kind', 'remedy', ...(kind?.required ?? [])]) {
    if (typeof rule[key] !== 'string') {
      errors.push(`rule.${key} must be a string — the rule is data, not structure`);
    }
  }
  if (kind !== undefined) errors.push(...kind.validate(stringFields(rule)));

  if (typeof rule.remedy === 'string' && carriesSubstitution(rule.remedy)) {
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
  if (!isRecord(front.rule)) {
    return [`rule must be a block of kind, remedy, override and what the kind requires — the `
      + `kinds are ${RULE_KINDS.join(', ')}`];
  }
  return checkRuleFields(front.rule);
}

export interface Inspection {
  name: string | undefined;
  errors: string[];
  // The fields, once, for callers that must act on a taste rather than only
  // report on it. Present whenever the frontmatter parsed as a mapping — a
  // caller reads it only after finding no errors.
  front?: Record<string, unknown>;
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
  return { name: scalar(front.name), errors, front };
}

// `skipTop` applies to the top level only: it is how the owner's own tastes are
// read without the external subtree sitting at the same root coming with them.
export function markdownFiles(dir: string, skipTop?: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === skipTop) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(path));
    else if (entry.name.endsWith('.md')) found.push(path);
  }
  return found;
}

// A directory named `external` anywhere but the root it is read at looks like a
// stack of sources and is read by nothing. Named rather than walked past: a
// folder inside a linted tree that no run ever checks is the failure the lint
// exists to prevent.
function reservedDirectories(dir: string, relativeTo: string, skipTop?: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === skipTop) continue;
    const path = join(dir, entry.name);
    if (entry.name === EXTERNAL_DIR) found.push(`${relative(relativeTo, path)}: ${RESERVED}`);
    else found.push(...reservedDirectories(path, relativeTo));
  }
  return found;
}

function duplicateNames(byName: Map<string, string[]>): string[] {
  return [...byName.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([name, paths]) => `duplicate name ${JSON.stringify(name)}: ${paths.sort().join(', ')}`);
}

export function lintTasteDirectory(
  dir: string,
  relativeTo: string = dir,
  skipTop?: string,
): string[] {
  const errors = reservedDirectories(dir, relativeTo, skipTop);
  // Keyed on the parsed name rather than the name: line, because `"tier"` and
  // `tier # why` are the same identity to every reader of these files, and a
  // collision the lint cannot see is two tastes claiming one name.
  const byName = new Map<string, string[]>();

  for (const file of markdownFiles(dir, skipTop).sort()) {
    const path = relative(relativeTo, file);
    const inspection = inspectTaste(path, readFileSync(file, 'utf-8'));
    errors.push(...inspection.errors.map((error) => `${path}: ${error}`));
    if (inspection.name !== undefined) {
      byName.set(inspection.name, [...(byName.get(inspection.name) ?? []), path]);
    }
  }

  return [...errors, ...duplicateNames(byName)].sort();
}

export function countTastes(dir: string): number {
  return markdownFiles(dir).length;
}

// The external tree holds one directory per source, and a name two sources both
// define is the stacking the sources list exists for: the later source is
// subscribed to in order to win it. Dedupe therefore stops at the source
// boundary here, exactly as it does when each source is linted on its own.
function lintExternalRoot(root: string, relativeTo: string = root): string[] {
  const errors: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      errors.push(...lintTasteDirectory(path, relativeTo));
    } else if (entry.name.endsWith('.md')) {
      errors.push(
        `${relative(relativeTo, path)}: sits outside every source directory — the external tree `
          + 'holds one directory per declared source, and nothing reads a taste at its root',
      );
    }
  }
  return errors.sort();
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

// A tastes root handed over whole is the invocation the skill asks for, so it
// has to be the correct one: the owner's own files are one dedupe scope, and
// `external/` beneath them is delegated a source at a time.
export function lintTastePath(dir: string): string[] {
  const base = basename(resolve(dir));
  if (base === EXTERNAL_DIR || base === LEGACY_EXTERNAL_ROOT) return lintExternalRoot(dir);

  const errors = lintTasteDirectory(dir, dir, EXTERNAL_DIR);
  const external = join(dir, EXTERNAL_DIR);
  if (isDirectory(external)) errors.push(...lintExternalRoot(external, dir));
  return errors.sort();
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
    errors.push(...lintTastePath(dir));
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
  console.log(`${checked} taste${checked === 1 ? '' : 's'} checked, all valid`);
}

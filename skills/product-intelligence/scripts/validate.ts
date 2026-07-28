#!/usr/bin/env bun
// Self-contained validator for product-intelligence documents. The JSON Schema
// files are the source of truth for structure; this file implements only the
// schema subset they use, plus the cross-field rules a schema cannot express.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

type Json = unknown;
type Schema = Record<string, Json>;

const schemasDir = join(import.meta.dir, '..', 'schemas');
export const ledgerSchema = loadSchema('ledger.schema.json');
export const briefSchema = loadSchema('brief.schema.json');
export const productSchema = loadSchema('product.schema.json');
export const partOfSchema = loadSchema('part-of.schema.json');

function loadSchema(name: string): Schema {
  return JSON.parse(readFileSync(join(schemasDir, name), 'utf-8'));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):?[0-5]\d)?$/;

// Shape alone lets 2026-13-45 through; round-trip through Date catches it.
function isDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(2000, m - 1, d));
  date.setUTCFullYear(y); // Date.UTC would remap years 0-99 to 1900-1999
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// The ledger declares generated_at as "date (or date-time)"; accept both.
function isDateTime(value: string): boolean {
  if (!isDate(value.slice(0, 10))) return false;
  const rest = value.slice(10);
  return rest === '' || ((rest[0] === 'T' || rest[0] === ' ') && TIME_RE.test(rest.slice(1)));
}

function resolveRef(root: Schema, ref: string): Schema {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref: ${ref}`);
  let node: Json = root;
  for (const part of ref.slice(2).split('/')) {
    node = (node as Record<string, Json>)[part];
    if (node === undefined) throw new Error(`dangling $ref: ${ref}`);
  }
  return node as Schema;
}

function typeOf(value: Json): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

export function checkSchema(value: Json, schema: Schema, root: Schema, path: string, errors: string[]): void {
  if (typeof schema.$ref === 'string') {
    checkSchema(value, resolveRef(root, schema.$ref), root, path, errors);
    return;
  }
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((v) => v === value)) {
      errors.push(`${path}: must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
    }
    return;
  }
  if (typeof schema.type === 'string' && typeOf(value) !== schema.type) {
    errors.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`);
    return;
  }
  if (schema.type === 'string') checkString(value as string, schema, path, errors);
  if (schema.type === 'object') checkObject(value as Record<string, Json>, schema, root, path, errors);
  if (schema.type === 'array' && schema.items) {
    (value as Json[]).forEach((item, i) => checkSchema(item, schema.items as Schema, root, `${path}[${i}]`, errors));
  }
}

function checkString(value: string, schema: Schema, path: string, errors: string[]): void {
  if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
    errors.push(`${path}: must be at least ${schema.minLength} character(s)`);
  }
  if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: does not match pattern ${schema.pattern}`);
  }
  if (schema.format === 'date' && !isDate(value)) {
    errors.push(`${path}: expected a real ISO-8601 date (YYYY-MM-DD)`);
  }
  if (schema.format === 'date-time' && !isDateTime(value)) {
    errors.push(`${path}: expected a real ISO-8601 date or date-time`);
  }
}

function checkObject(
  value: Record<string, Json>,
  schema: Schema,
  root: Schema,
  path: string,
  errors: string[],
): void {
  const props = (schema.properties ?? {}) as Record<string, Schema>;
  for (const key of (schema.required ?? []) as string[]) {
    if (value[key] === undefined) errors.push(`${path}: missing required field '${key}'`);
  }
  for (const [key, item] of Object.entries(value)) {
    const prop = props[key];
    if (!prop) {
      if (schema.additionalProperties === false) errors.push(`${path}: unknown field '${key}'`);
      continue;
    }
    checkSchema(item, prop, root, `${path}.${key}`, errors);
  }
}

interface Claim {
  id?: string;
  class?: string;
  sources?: Json[];
  derived_from?: string[];
  contradicts?: string[];
}

export function validateLedgerDoc(doc: Json): string[] {
  const errors: string[] = [];
  checkSchema(doc, ledgerSchema, ledgerSchema, 'ledger', errors);
  if (errors.length > 0) return errors;

  const claims = ((doc as Record<string, Json>).claims ?? []) as Claim[];
  const byId = new Map<string, Claim>();
  for (const claim of claims) {
    if (!claim.id) continue;
    if (byId.has(claim.id)) errors.push(`ledger: duplicate claim id '${claim.id}'`);
    byId.set(claim.id, claim);
  }
  for (const claim of claims) checkClaimRules(claim, byId, errors);
  return errors;
}

function checkClaimRules(claim: Claim, byId: Map<string, Claim>, errors: string[]): void {
  const id = claim.id ?? '?';
  const evidenced = claim.class === 'observed' || claim.class === 'inferred';
  if (evidenced && (claim.sources ?? []).length === 0) {
    errors.push(`ledger claim ${id}: class '${claim.class}' requires at least one source`);
  }
  const derived = claim.derived_from ?? [];
  if (derived.length > 0 && claim.class !== 'inferred') {
    errors.push(`ledger claim ${id}: derived_from is only valid for class 'inferred'`);
  }
  for (const ref of derived) {
    const target = byId.get(ref);
    if (ref === id) errors.push(`ledger claim ${id}: derived_from must not reference itself`);
    else if (!target) errors.push(`ledger claim ${id}: derived_from references unknown claim '${ref}'`);
    else if (target.class === 'proposed') {
      errors.push(
        `ledger claim ${id}: cannot be inferred from proposed claim '${ref}' — proposals are not evidence about the present`,
      );
    }
  }
  for (const ref of claim.contradicts ?? []) {
    const target = byId.get(ref);
    if (ref === id) errors.push(`ledger claim ${id}: contradicts must not reference itself`);
    else if (!target) errors.push(`ledger claim ${id}: contradicts references unknown claim '${ref}'`);
    else if (!(target.contradicts ?? []).includes(id)) {
      errors.push(`ledger claim ${id}: contradiction with '${ref}' is not symmetric — '${ref}' must list ${id}`);
    }
  }
}

export function validateBriefDoc(doc: Json, ledger?: Json): string[] {
  const errors: string[] = [];
  checkSchema(doc, briefSchema, briefSchema, 'brief', errors);
  if (errors.length > 0) return errors;

  const brief = doc as Record<string, Json>;
  for (const [i, page] of (((brief.site_inventory ?? []) as Record<string, Json>[])).entries()) {
    if (page.disposition !== undefined && page.rationale === undefined) {
      errors.push(`brief.site_inventory[${i}]: a disposition requires a rationale`);
    }
  }
  checkOrigins(brief, ledger, errors);
  if (ledger !== undefined) {
    const known = new Set(
      (((ledger as Record<string, Json>).claims ?? []) as Claim[]).map((c) => c.id).filter(Boolean),
    );
    for (const { path, ref } of collectClaimRefs(brief, 'brief')) {
      if (!known.has(ref)) errors.push(`${path}: references unknown ledger claim '${ref}'`);
    }
  }
  return errors;
}

// One brief may span several repos/sites; a locator like 'repo:README.md'
// cannot say which. Qualification is demanded exactly when it is ambiguous:
// two origins of one kind make every locator of that kind name its origin.
const KIND_SCHEMES: Record<string, string[]> = { site: ['site'], repo: ['repo', 'gh'], docset: ['doc'] };

interface Origin {
  id?: string;
  kind?: string;
}

function checkOrigins(brief: Record<string, Json>, ledger: Json | undefined, errors: string[]): void {
  const origins = ((brief.subject as Record<string, Json> | undefined)?.origins ?? []) as Origin[];
  if (origins.length === 0) return;

  const idsByKind = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const origin of origins) {
    if (!origin.id || !origin.kind) continue;
    if (seen.has(origin.id)) {
      errors.push(`brief.subject.origins: duplicate origin id '${origin.id}'`);
      continue;
    }
    seen.add(origin.id);
    idsByKind.set(origin.kind, [...(idsByKind.get(origin.kind) ?? []), origin.id]);
  }

  const ambiguous = new Map<string, string[]>();
  for (const [kind, ids] of idsByKind) {
    if (ids.length < 2) continue;
    for (const scheme of KIND_SCHEMES[kind] ?? []) ambiguous.set(scheme, ids);
  }
  if (ambiguous.size === 0) return;

  for (const { path, locator } of collectLocators(brief, ledger)) {
    const [scheme, second] = locator.split(':');
    const ids = ambiguous.get(scheme);
    if (ids && !ids.includes(second ?? '')) {
      errors.push(`${path}: locator '${locator}' must name its origin — ${scheme}:<${ids.join('|')}>:…`);
    }
  }
}

function collectLocators(brief: Record<string, Json>, ledger: Json | undefined): { path: string; locator: string }[] {
  const out: { path: string; locator: string }[] = [];
  for (const [i, page] of (((brief.site_inventory ?? []) as Record<string, Json>[])).entries()) {
    if (typeof page.locator === 'string') out.push({ path: `brief.site_inventory[${i}]`, locator: page.locator });
  }
  const claims = (((ledger as Record<string, Json> | undefined)?.claims ?? []) as Claim[]);
  for (const [i, claim] of claims.entries()) {
    for (const [j, source] of ((claim.sources ?? []) as Record<string, Json>[]).entries()) {
      if (typeof source.locator === 'string') {
        out.push({ path: `ledger claim ${claim.id ?? i}: sources[${j}]`, locator: source.locator });
      }
    }
  }
  return out;
}

function collectClaimRefs(node: Json, path: string): { path: string; ref: string }[] {
  if (Array.isArray(node)) {
    return node.flatMap((item, i) => collectClaimRefs(item, `${path}[${i}]`));
  }
  if (typeOf(node) !== 'object') return [];
  const refs: { path: string; ref: string }[] = [];
  for (const [key, value] of Object.entries(node as Record<string, Json>)) {
    if (key === 'claims' && Array.isArray(value)) {
      for (const ref of value) {
        if (typeof ref === 'string') refs.push({ path: `${path}.claims`, ref });
      }
    } else {
      refs.push(...collectClaimRefs(value, `${path}.${key}`));
    }
  }
  return refs;
}

export interface Part {
  id?: string;
  kind?: string;
  target?: string;
  role?: string;
  visibility?: string;
  description?: string;
}

export function partsOf(doc: Json): Part[] {
  const composition = (doc as Record<string, Json>).composition as Record<string, Json> | undefined;
  return (composition?.parts ?? []) as Part[];
}

export function validateProductDoc(doc: Json): string[] {
  const errors: string[] = [];
  checkSchema(doc, productSchema, productSchema, 'product', errors);
  if (errors.length > 0) return errors;

  const seen = new Set<string>();
  for (const part of partsOf(doc)) {
    if (!part.id) continue;
    if (seen.has(part.id)) errors.push(`product.composition.parts: duplicate part id '${part.id}'`);
    seen.add(part.id);
  }
  return errors;
}

// The marker rides inside the component's product-review manifest, so validate
// that one key and leave the sibling surfaces/requires blocks to product-review.
export function validatePartOfDoc(doc: Json): string[] {
  const errors: string[] = [];
  checkSchema((doc as Record<string, Json>).part_of, partOfSchema, partOfSchema, 'part_of', errors);
  return errors;
}

// A declaration whose evidence has moved is worse than one that never had any:
// it reads as sourced right up until somebody follows the pointer.
function validateProductFile(doc: Json, path: string): string[] {
  const errors = validateProductDoc(doc);
  if (errors.length > 0) return errors;

  const root = doc as Record<string, Json>;
  const pointers: [string, Json][] = Object.entries((root.evidence ?? {}) as Record<string, Json>)
    .map(([key, value]) => [`evidence.${key}`, value] as [string, Json]);
  const entry = (root.site as Record<string, Json> | undefined)?.entry;
  if (entry !== undefined) pointers.push(['site.entry', entry]);

  for (const [field, value] of pointers) {
    if (typeof value !== 'string') continue;
    if (!existsSync(resolve(dirname(path), value))) {
      errors.push(`product.${field}: '${value}' not found relative to the declaration`);
    }
  }
  return errors;
}

export function parseDocument(path: string): Json {
  const text = readFileSync(path, 'utf-8');
  return path.endsWith('.json') ? JSON.parse(text) : Bun.YAML.parse(text);
}

export function validateFile(path: string): string[] {
  let doc: Json;
  try {
    doc = parseDocument(path);
  } catch (error) {
    return [`${path}: unparseable — ${(error as Error).message}`];
  }
  if (typeOf(doc) !== 'object') return [`${path}: document must be a mapping`];
  const root = doc as Record<string, Json>;
  if (root.ledger_version !== undefined) return validateLedgerDoc(doc);
  if (root.brief_version !== undefined) return validateBriefFile(doc, path);
  if (root.product_version !== undefined) return validateProductFile(doc, path);
  if (root.part_of !== undefined) return validatePartOfDoc(doc);
  return [
    `${path}: not a recognised document — expected ledger_version, brief_version, product_version or part_of`,
  ];
}

function validateBriefFile(doc: Json, path: string): string[] {
  const ledgerRel = ((doc as Record<string, Json>).evidence as Record<string, Json> | undefined)?.ledger;
  if (typeof ledgerRel !== 'string') return validateBriefDoc(doc);
  const ledgerPath = resolve(dirname(path), ledgerRel);
  if (!existsSync(ledgerPath)) {
    return [`${path}: evidence.ledger '${ledgerRel}' not found`, ...validateBriefDoc(doc)];
  }
  let ledger: Json;
  try {
    ledger = parseDocument(ledgerPath);
  } catch (error) {
    return [`${path}: evidence.ledger unparseable — ${(error as Error).message}`];
  }
  const ledgerErrors = validateLedgerDoc(ledger).map((e) => `${path}: evidence.ledger: ${e}`);
  return [...ledgerErrors, ...validateBriefDoc(doc, ledger)];
}

if (import.meta.main) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: validate.ts <ledger-or-brief>...');
    process.exit(2);
  }
  let failed = false;
  for (const file of files) {
    const errors = validateFile(file);
    if (errors.length === 0) {
      console.log(`ok: ${file}`);
    } else {
      failed = true;
      for (const error of errors) console.error(`error: ${error}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

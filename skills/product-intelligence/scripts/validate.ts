#!/usr/bin/env bun
// Self-contained validator for product-intelligence ledgers and briefs.
// The JSON Schema files are the source of truth for structure; this file
// implements only the schema subset they use, plus the cross-field rules a
// schema cannot express (class/source coupling, contradiction symmetry,
// cross-document claim references).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

type Json = unknown;
type Schema = Record<string, Json>;

const schemasDir = join(import.meta.dir, '..', 'schemas');
export const ledgerSchema = loadSchema('ledger.schema.json');
export const briefSchema = loadSchema('brief.schema.json');

function loadSchema(name: string): Schema {
  return JSON.parse(readFileSync(join(schemasDir, name), 'utf-8'));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// The ledger declares generated_at as "date (or date-time)"; accept both.
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

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
    errors.push(`${path}: must not be empty`);
  }
  if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: does not match pattern ${schema.pattern}`);
  }
  if (schema.format === 'date' && !DATE_RE.test(value)) {
    errors.push(`${path}: expected an ISO-8601 date (YYYY-MM-DD)`);
  }
  if (schema.format === 'date-time' && !DATE_TIME_RE.test(value)) {
    errors.push(`${path}: expected an ISO-8601 date or date-time`);
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
  return [`${path}: neither a ledger (ledger_version) nor a brief (brief_version)`];
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

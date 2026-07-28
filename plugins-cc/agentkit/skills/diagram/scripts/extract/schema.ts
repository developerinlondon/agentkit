// tbls JSON -> a crow's-foot ERD in D2 `sql_table` notation.
//
//   tbls out -t json 'postgres://user:pass@host:5432/db' > schema.json

import { ExtractError, finish, header, quote, titleBlock } from "./model.ts";

interface TblsColumn {
  name: string;
  type: string;
  nullable?: boolean;
}

interface TblsConstraint {
  type?: string;
  columns?: string[];
}

interface TblsTable {
  name: string;
  type?: string;
  columns?: TblsColumn[];
  constraints?: TblsConstraint[];
}

interface TblsRelation {
  table: string;
  columns: string[];
  cardinality?: string;
  parent_table: string;
  parent_columns: string[];
  parent_cardinality?: string;
}

interface TblsSchema {
  name?: string;
  driver?: { name?: string };
  tables?: TblsTable[];
  relations?: TblsRelation[];
}

export interface SchemaOptions {
  tables?: string[];
  maxNodes: number;
  title?: string;
  direction?: string;
}

export function parseTbls(raw: string): TblsSchema {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ExtractError(`input is not JSON: ${(e as Error).message}`);
  }
  const schema = parsed as TblsSchema;
  if (!Array.isArray(schema.tables) || schema.tables.length === 0) {
    throw new ExtractError("input has no `tables` — expected `tbls out -t json` output");
  }
  return schema;
}

// tbls spells the constraint type the way the driver does, so the match is on
// the substring every driver agrees on rather than on an exact vocabulary.
const BADGES: ReadonlyArray<readonly [RegExp, string]> = [
  [/primary/i, "primary_key"],
  [/foreign/i, "foreign_key"],
  [/unique/i, "unique"],
];

export function badgesFor(table: TblsTable, column: string): string[] {
  const found: string[] = [];
  for (const constraint of table.constraints ?? []) {
    if (!(constraint.columns ?? []).includes(column)) continue;
    for (const [pattern, badge] of BADGES) {
      if (pattern.test(constraint.type ?? "") && !found.includes(badge)) found.push(badge);
    }
  }
  return found;
}

// tbls derives these from the foreign key's nullability and uniqueness, which
// is exactly the required-versus-optional distinction the crow's foot encodes.
// Arrowhead and notation come from one lookup so they cannot drift apart.
const CARDINALITY: Record<string, { arrowhead: string; notation: string }> = {
  zero_or_one: { arrowhead: "cf-one", notation: "0..1" },
  exactly_one: { arrowhead: "cf-one-required", notation: "1..1" },
  zero_or_more: { arrowhead: "cf-many", notation: "0..N" },
  one_or_more: { arrowhead: "cf-many-required", notation: "1..N" },
};

// Nothing is drawn for a cardinality tbls did not state: the register's rule
// is get it right or do not draw it, and defaulting would invent the one kind
// of claim this transform exists to stop inventing. An unrecognised value is
// refused outright rather than guessed.
function known(cardinality: string | undefined): { arrowhead: string; notation: string } | undefined {
  if (cardinality === undefined || cardinality === "") return undefined;
  const found = CARDINALITY[cardinality];
  if (found === undefined) {
    throw new ExtractError(
      `unknown tbls cardinality "${cardinality}" — refusing to guess a crow's foot`,
    );
  }
  return found;
}

function emitTable(table: TblsTable): string[] {
  const lines = [`${quote(table.name)}: {`, "  shape: sql_table"];
  for (const column of table.columns ?? []) {
    const badges = badgesFor(table, column.name);
    const constraint = badges.length === 0
      ? ""
      : ` {constraint: ${badges.length === 1 ? badges[0] : `[${badges.join("; ")}]`}}`;
    // The type is reproduced verbatim — an ERD is read as a schema, and a
    // prettified type is a wrong one — but verbatim means quoted, not raw:
    // SQLite stores a declared type as free text and Postgres type names are
    // quoted identifiers, so a type can carry braces and newlines that would
    // otherwise close this table and declare nodes of their own.
    lines.push(`  ${quote(column.name)}: ${quote(column.type)}${constraint}`);
  }
  lines.push("}");
  return lines;
}

function emitRelation(relation: TblsRelation): string[] {
  const parentColumn = relation.parent_columns[0];
  const childColumn = relation.columns[0];
  if (parentColumn === undefined || childColumn === undefined) {
    throw new ExtractError(
      `relation ${relation.parent_table} -> ${relation.table} names no columns`,
    );
  }
  const source = `${quote(relation.parent_table)}.${quote(parentColumn)}`;
  const target = `${quote(relation.table)}.${quote(childColumn)}`;
  const child = known(relation.cardinality);
  const parent = known(relation.parent_cardinality);
  const head = `${source} -> ${target}`;
  const attrs = [
    ...(parent === undefined ? [] : [`  source-arrowhead.shape: ${parent.arrowhead}`]),
    ...(child === undefined ? [] : [`  target-arrowhead.shape: ${child.arrowhead}`]),
  ];
  const labelled = child === undefined ? head : `${head}: ${quote(child.notation)}`;
  return attrs.length === 0 ? [labelled] : [`${labelled} {`, ...attrs, "}"];
}

export function buildErd(schema: TblsSchema, options: SchemaOptions): string {
  const wanted = options.tables === undefined ? undefined : new Set(options.tables);
  const tables = (schema.tables ?? [])
    .filter((t) => wanted === undefined || wanted.has(t.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (wanted !== undefined) {
    const missing = [...wanted].filter((name) => !tables.some((t) => t.name === name));
    if (missing.length > 0) {
      throw new ExtractError(`--tables names tables the schema does not have: ${missing.join(", ")}`);
    }
  }
  if (tables.length > options.maxNodes) {
    throw new ExtractError(
      `${tables.length} tables exceeds the density budget of ${options.maxNodes} — an ERD `
        + "that wide is a reference, not a figure. Select a subsystem with --tables, or "
        + "raise the budget deliberately with --max-nodes.",
    );
  }

  const present = new Set(tables.map((t) => t.name));
  const relations = (schema.relations ?? [])
    .filter((r) => present.has(r.table) && present.has(r.parent_table))
    .sort((a, b) =>
      `${a.parent_table}.${a.parent_columns[0]}.${a.table}`.localeCompare(
        `${b.parent_table}.${b.parent_columns[0]}.${b.table}`,
      )
    );

  const driver = schema.driver?.name ?? "unknown driver";
  const counts = `${tables.length} tables, ${relations.length} relations`;
  const lines = header(`derived from tbls JSON (${driver}) — ${counts}`, options.direction);
  if (options.title !== undefined) lines.push(...titleBlock(options.title));
  for (const table of tables) lines.push(...emitTable(table), "");
  for (const relation of relations) lines.push(...emitRelation(relation));
  return finish(lines);
}

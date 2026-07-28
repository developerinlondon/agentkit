#!/usr/bin/env bun
// Derives D2 source for the technical register from what a project already
// has: its modules, its schema, its state files, its manifests. The model
// chooses the scope; the graph itself is never authored by hand.

import { readFileSync } from "node:fs";
import { buildGraph as buildDeps, parseCruiser } from "./extract/deps.ts";
import { buildGraph as buildInfra, parseState } from "./extract/infra.ts";
import { buildGraph as buildK8s, parseObjects } from "./extract/k8s.ts";
import { buildErd, parseTbls } from "./extract/schema.ts";
import { DEFAULT_MAX_NODES, emit, ExtractError, type Graph } from "./extract/model.ts";

const KINDS = ["deps", "schema", "infra", "k8s"] as const;
type Kind = (typeof KINDS)[number];

const USAGE = `usage: extract.ts <${KINDS.join("|")}> [--in FILE] [--out FILE] [options]

  deps    dependency-cruiser JSON  ->  C4 component view of module dependencies
          depcruise --no-config --output-type json 'src/**/*.ts'
          --focus PREFIX  --group-depth N (default 2)  --externals

  schema  tbls JSON                ->  crow's-foot ERD
          tbls out -t json 'postgres://…'
          --tables a,b,c

  infra   tofu show -json          ->  deployment topology
          tofu show -json
          --group-by type  --no-reduce

  k8s     manifests or kubectl -o json  ->  deployment topology
          kubectl get all,ing,pvc -n NS -o json   |   kubectl kustomize DIR
          --namespace NS  --config

common:   --title TEXT  --max-nodes N (default ${DEFAULT_MAX_NODES})  --direction down|right`;

function fail(message: string): never {
  console.error(`extract: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);

function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) fail(`--${name} is missing its value`);
  return value;
}

function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}

function integer(name: string, fallback: number): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) fail(`--${name} must be a positive integer`);
  return value;
}

function known(): Kind {
  const kind = argv[0];
  if (kind === undefined || kind.startsWith("--")) fail(`no extractor named\n\n${USAGE}`);
  if (!(KINDS as readonly string[]).includes(kind)) {
    fail(`unknown extractor "${kind}"\n\n${USAGE}`);
  }
  return kind as Kind;
}

async function readInput(): Promise<string> {
  const file = arg("in");
  if (file !== undefined) {
    try {
      return readFileSync(file, "utf8");
    } catch (e) {
      fail(`cannot read ${file}: ${(e as Error).message}`);
    }
  }
  if (process.stdin.isTTY === true) fail(`no --in FILE and nothing on stdin\n\n${USAGE}`);
  return await Bun.stdin.text();
}

const DIRECTIONS = ["down", "right", "up", "left"];

function direction(): string {
  const value = arg("direction") ?? "down";
  if (!DIRECTIONS.includes(value)) fail(`--direction must be one of ${DIRECTIONS.join(", ")}`);
  return value;
}

function transform(kind: Kind, raw: string): string {
  const maxNodes = integer("max-nodes", DEFAULT_MAX_NODES);
  const title = arg("title");
  if (kind === "schema") {
    const tables = arg("tables")?.split(",").map((t) => t.trim()).filter((t) => t !== "");
    return buildErd(parseTbls(raw), { tables, maxNodes, title });
  }
  if (kind === "deps") {
    const graph = buildDeps(parseCruiser(raw), {
      focus: arg("focus"),
      groupDepth: integer("group-depth", 2),
      externals: flag("externals"),
      maxNodes,
      title,
    });
    return render(graph, "dependency-cruiser JSON");
  }
  if (kind === "infra") {
    const graph = buildInfra(parseState(raw), {
      groupByType: arg("group-by") === "type",
      reduce: !flag("no-reduce"),
      maxNodes,
      title,
    });
    return render(graph, "tofu show -json");
  }
  const graph = buildK8s(parseObjects(raw), {
    namespace: arg("namespace"),
    config: flag("config"),
    maxNodes,
    title,
  });
  return render(graph, "Kubernetes objects");
}

// The provenance line deliberately records no input path: d2 salts element ids
// from the source it compiles, so a checkout location here would make the
// render depend on where the repository sits.
function render(graph: Graph, source: string): string {
  graph.direction = direction();
  const counts = `${graph.nodes.length} nodes, ${graph.edges.length} edges`;
  return emit(graph, `derived from ${source} — ${counts}`);
}

if (import.meta.main) {
  const kind = known();
  let d2: string;
  try {
    d2 = transform(kind, await readInput());
  } catch (e) {
    if (e instanceof ExtractError) fail(e.message);
    throw e;
  }
  const out = arg("out");
  if (out === undefined) process.stdout.write(d2);
  else await Bun.write(out, d2);
}

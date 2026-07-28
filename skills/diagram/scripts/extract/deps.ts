// dependency-cruiser JSON -> a C4-component view of module dependencies.
//
//   depcruise --no-config --output-type json 'src/**/*.ts' > deps.json

import {
  assertDensity,
  type Edge,
  ExtractError,
  type Graph,
  idAssigner,
  type Node,
} from "./model.ts";

interface Resolvable {
  coreModule?: boolean;
  couldNotResolve?: boolean;
}

interface CruiserDependency extends Resolvable {
  resolved?: string;
}

interface CruiserModule extends Resolvable {
  source: string;
  dependencies?: CruiserDependency[];
}

interface CruiserOutput {
  modules?: CruiserModule[];
}

export interface DepsOptions {
  focus?: string;
  groupDepth: number;
  externals: boolean;
  maxNodes: number;
  title?: string;
}

const EXTERNAL = "external";

export function parseCruiser(raw: string): CruiserOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ExtractError(`input is not JSON: ${(e as Error).message}`);
  }
  const output = parsed as CruiserOutput;
  if (!Array.isArray(output.modules)) {
    throw new ExtractError(
      "input has no `modules` array — expected `depcruise --output-type json` output",
    );
  }
  if (output.modules.length === 0) {
    throw new ExtractError(
      "dependency-cruiser reported zero modules — it cruised nothing. Pass a glob "
        + "(`'src/**/*.ts'`) rather than a bare directory when the sources are TypeScript.",
    );
  }
  return output;
}

function normalise(focus: string | undefined): string {
  if (focus === undefined) return "";
  const trimmed = focus.replace(/^\.\//, "").replace(/\/+$/, "");
  return trimmed === "" ? "" : `${trimmed}/`;
}

// A package under node_modules is identified by its published name, not by the
// file inside it that happened to be imported: `react/jsx-runtime.js` and
// `react/index.js` are one dependency, drawn once.
function packageName(path: string): string {
  const after = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  const parts = after.split("/");
  return parts[0]?.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? after);
}

// dependency-cruiser lists every node of the graph as a module, so the entries
// include core builtins and files inside node_modules. Both sides of an edge
// go through this, or `fs` becomes a top-level component of the project.
export function bucket(
  path: string | undefined,
  flags: Resolvable,
  options: DepsOptions,
): string | undefined {
  if (path === undefined) return undefined;
  if (flags.coreModule === true) return options.externals ? `${EXTERNAL}/node builtins` : undefined;
  if (path.includes("node_modules/")) {
    return options.externals ? `${EXTERNAL}/${packageName(path)}` : undefined;
  }
  if (flags.couldNotResolve === true) {
    return options.externals ? `${EXTERNAL}/${path}` : undefined;
  }
  const prefix = normalise(options.focus);
  if (!path.startsWith(prefix)) return undefined;
  const parts = path.slice(prefix.length).split("/");
  // A file shallower than the requested depth groups under its own name rather
  // than being silently folded into a sibling.
  return (parts.length > options.groupDepth ? parts.slice(0, options.groupDepth) : parts).join("/");
}

// dependency-cruiser lists a file twice when a glob matched it and something
// also imported it. The copies are not identical — one may carry the resolver
// flags and the other the dependencies — so they are merged, not deduplicated
// by first sighting, or a module's imports go missing along with its double.
export function dedupe(modules: readonly CruiserModule[]): CruiserModule[] {
  const merged = new Map<string, CruiserModule>();
  for (const mod of modules) {
    const seen = merged.get(mod.source);
    if (seen === undefined) {
      merged.set(mod.source, { ...mod, dependencies: [...(mod.dependencies ?? [])] });
      continue;
    }
    const known = new Set((seen.dependencies ?? []).map((d) => d.resolved));
    for (const dep of mod.dependencies ?? []) {
      if (!known.has(dep.resolved)) (seen.dependencies as CruiserDependency[]).push(dep);
    }
    seen.coreModule ??= mod.coreModule;
    seen.couldNotResolve ??= mod.couldNotResolve;
  }
  return [...merged.values()];
}

type Weights = Map<string, Map<string, number>>;

function bump(weights: Weights, from: string, to: string): void {
  const row = weights.get(from) ?? new Map<string, number>();
  row.set(to, (row.get(to) ?? 0) + 1);
  weights.set(from, row);
}

export function buildGraph(output: CruiserOutput, options: DepsOptions): Graph {
  const modules = new Map<string, number>();
  const weights: Weights = new Map();

  for (const mod of dedupe(output.modules ?? [])) {
    const from = bucket(mod.source, mod, options);
    if (from === undefined || from.startsWith(`${EXTERNAL}/`)) continue;
    modules.set(from, (modules.get(from) ?? 0) + 1);
    for (const dep of mod.dependencies ?? []) {
      const to = bucket(dep.resolved, dep, options);
      if (to === undefined || to === from) continue;
      if (!modules.has(to)) modules.set(to, 0);
      bump(weights, from, to);
    }
  }

  if (modules.size === 0) {
    throw new ExtractError(
      `no project modules matched${options.focus === undefined ? "" : ` --focus ${options.focus}`}`
        + " — check the prefix against the `source` paths in the input",
    );
  }

  const graph = assemble(modules, weights, options);
  // The density budget only refuses too many nodes. Grouping fails the other
  // way just as silently: every module under one top directory buckets to one
  // box, and a single box with no edges is a figure that argues nothing.
  if (graph.nodes.length < 2) {
    throw new ExtractError(
      `every module grouped into the single box "${graph.nodes[0]?.label ?? ""}" — nothing `
        + "is left to draw a relationship between. Raise --group-depth, or --focus the "
        + "subtree whose components you want compared.",
    );
  }
  assertDensity(graph, options.maxNodes, "--focus a subtree, or lower --group-depth");
  return graph;
}

function zoneOf(path: string): string | undefined {
  // A scoped package name carries a slash that is not a directory boundary:
  // `@excalidraw/excalidraw` is one package, not a package inside a folder.
  if (path.startsWith(`${EXTERNAL}/`)) return EXTERNAL;
  const cut = path.lastIndexOf("/");
  return cut < 0 ? undefined : path.slice(0, cut);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function assemble(modules: Map<string, number>, weights: Weights, options: DepsOptions): Graph {
  const paths = [...modules.keys()].sort();
  const zonePaths = [
    ...new Set(paths.map(zoneOf).filter((z): z is string => z !== undefined)),
  ].sort();

  const assign = idAssigner();
  const zoneIds = new Map(zonePaths.map((path) => [path, assign(path)]));
  const nodeIds = new Map(paths.map((path) => [path, assign(path)]));
  const idOf = (path: string): string => nodeIds.get(path) as string;

  const nodes: Node[] = paths.map((path) => {
    const zone = zoneOf(path);
    const count = modules.get(path) ?? 0;
    return {
      id: idOf(path),
      label: path.slice((zone?.length ?? -1) + 1),
      tech: count === 0 ? undefined : plural(count, "module"),
      zone: zone === undefined ? undefined : zoneIds.get(zone),
    };
  });

  const edges: Edge[] = [];
  for (const from of paths) {
    for (const [to, count] of [...(weights.get(from) ?? [])].sort(([a], [b]) => a.localeCompare(b))) {
      const external = to.startsWith(`${EXTERNAL}/`);
      edges.push({
        from: idOf(from),
        to: idOf(to),
        // Many components reach the same few packages, so labelling those edges
        // stacks counts on top of one another until none of them reads — and
        // how often a component imports `node:fs` is not an argument anyway.
        label: external ? undefined : plural(count, "import"),
        // A pair pointing both ways is a cycle at this altitude, and a cycle is
        // the one thing a module graph exists to make visible.
        bold: weights.get(to)?.has(from) === true,
        dashed: external,
      });
    }
  }

  return {
    title: options.title,
    direction: "down",
    zones: zonePaths.map((path) => ({
      id: zoneIds.get(path) as string,
      label: path === EXTERNAL ? "external packages" : path,
      dashed: path === EXTERNAL,
    })),
    nodes,
    edges,
  };
}

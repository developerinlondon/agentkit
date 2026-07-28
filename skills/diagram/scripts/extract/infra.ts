// `tofu show -json` (or `terraform show -json`) -> a deployment topology.
//
//   tofu show -json > state.json

// State carries every resource attribute, including ones the provider marked
// sensitive, so nothing under `values` is ever read here: a diagram derived
// from state must not become a way to publish the state.

import {
  assertDensity,
  type Edge,
  ExtractError,
  type Graph,
  type Node,
  slug,
  uniqueSlug,
  type Zone,
} from "./model.ts";
import { manifest } from "../icons.ts";

interface StateResource {
  address: string;
  mode?: string;
  type?: string;
  name?: string;
  provider_name?: string;
  depends_on?: string[];
}

interface StateModule {
  address?: string;
  resources?: StateResource[];
  child_modules?: StateModule[];
}

interface State {
  format_version?: string;
  values?: { root_module?: StateModule };
}

export interface InfraOptions {
  groupByType: boolean;
  reduce: boolean;
  maxNodes: number;
  title?: string;
}

export function parseState(raw: string): State {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ExtractError(`input is not JSON: ${(e as Error).message}`);
  }
  const state = parsed as State;
  if (state.values?.root_module === undefined) {
    throw new ExtractError(
      "input has no `values.root_module` — expected `tofu show -json` output. A plan "
        + "file shows its resources under `planned_values`; render the applied state instead.",
    );
  }
  return state;
}

const PROVIDER_ICONS: Record<string, string> = {
  aws: "aws",
  azuread: "azure",
  azurerm: "azure",
  cloudflare: "cloudflare",
  docker: "docker",
  google: "gcp",
  "google-beta": "gcp",
  helm: "helm",
  kubernetes: "kubernetes",
  vault: "vault",
};

// A resource type narrows to the most specific vendored stencil that exists:
// `aws_ecs_service` prefers the ECS mark over the generic AWS one.
export function iconFor(resource: StateResource, icons = manifest()): string | undefined {
  const provider = (resource.provider_name ?? "").split("/").pop() ?? "";
  const base = PROVIDER_ICONS[provider];
  const parts = (resource.type ?? "").split("_");
  for (let take = parts.length; take >= 2; take--) {
    const candidate = parts.slice(0, take).join("-");
    if (Object.hasOwn(icons, candidate)) return candidate;
  }
  return base !== undefined && Object.hasOwn(icons, base) ? base : undefined;
}

function stripIndex(address: string): string {
  return address.replace(/\[[^\]]*\]$/, "");
}

interface Collected {
  resource: StateResource;
  module: string;
}

function walk(module: StateModule, into: Collected[]): void {
  const address = module.address ?? "";
  for (const resource of module.resources ?? []) {
    // Data sources read the world; they are not part of the topology it runs on.
    if (resource.mode === "data") continue;
    into.push({ resource, module: address });
  }
  for (const child of module.child_modules ?? []) walk(child, into);
}

interface Grouped {
  id: string;
  module: string;
  label: string;
  type: string;
  count: number;
  icon?: string;
  addresses: string[];
}

function group(collected: Collected[], byType: boolean): Grouped[] {
  const groups = new Map<string, Grouped>();
  for (const { resource, module } of collected) {
    const type = resource.type ?? "resource";
    const local = byType ? type : `${type}.${resource.name ?? ""}`;
    const key = `${module}|${local}`;
    const existing = groups.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      existing.addresses.push(resource.address);
      continue;
    }
    groups.set(key, {
      // The module prefix is already the enclosing container, so the id keeps
      // only the part that names the resource; the D2 path restores the rest.
      id: local,
      module,
      label: byType ? type : (resource.name ?? resource.address),
      type,
      count: 1,
      icon: iconFor(resource),
      addresses: [resource.address],
    });
  }
  const sorted = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  const taken = new Set<string>();
  return sorted.map(([, group]) => ({ ...group, id: uniqueSlug(group.id, taken) }));
}

// State records every ancestor a resource waited on, so a three-deep chain
// arrives as a fully connected triangle. Dropping an edge that a longer path
// already implies is what turns the dump back into a topology.
export function reduceTransitive(edges: Array<[string, string]>): Array<[string, string]> {
  const out = new Map<string, Set<string>>();
  for (const [from, to] of edges) {
    if (!out.has(from)) out.set(from, new Set());
    (out.get(from) as Set<string>).add(to);
  }
  const reachableBeyond = (from: string, skip: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [...(out.get(from) ?? [])].filter((n) => n !== skip);
    while (stack.length > 0) {
      const next = stack.pop() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      for (const onward of out.get(next) ?? []) stack.push(onward);
    }
    return seen;
  };
  return edges.filter(([from, to]) => !reachableBeyond(from, to).has(to));
}

function zonesFor(groups: Grouped[]): Zone[] {
  const modules = [...new Set(groups.map((g) => g.module))].filter((m) => m !== "").sort();
  return modules.map((address) => {
    const parent = modules
      .filter((m) => m !== address && address.startsWith(`${m}.`))
      .sort((a, b) => b.length - a.length)[0];
    return {
      id: slug(address),
      label: address,
      parent: parent === undefined ? undefined : slug(parent),
    };
  });
}

export function buildGraph(state: State, options: InfraOptions): Graph {
  const collected: Collected[] = [];
  walk(state.values?.root_module as StateModule, collected);
  if (collected.length === 0) {
    throw new ExtractError("state declares no managed resources — nothing to draw");
  }

  const groups = group(collected, options.groupByType);
  const byAddress = new Map<string, string>();
  for (const g of groups) {
    for (const address of g.addresses) {
      byAddress.set(address, g.id);
      byAddress.set(stripIndex(address), g.id);
    }
  }

  const pairs = new Set<string>();
  for (const { resource } of collected) {
    const from = byAddress.get(resource.address);
    for (const dependency of resource.depends_on ?? []) {
      const to = byAddress.get(dependency) ?? byAddress.get(stripIndex(dependency));
      if (from === undefined || to === undefined || from === to) continue;
      // The arrow points the way the topology is built, not the way the
      // dependency is declared: the thing depended on comes first.
      pairs.add(`${to} ${from}`);
    }
  }

  const listed = [...pairs].sort().map((p) => p.split(" ") as [string, string]);
  const kept = options.reduce ? reduceTransitive(listed) : listed;

  const nodes: Node[] = groups.map((g) => ({
    id: g.id,
    label: g.count > 1 ? `${g.label} ×${g.count}` : g.label,
    tech: options.groupByType ? undefined : g.type,
    icon: g.icon,
    multiple: g.count > 1,
    zone: g.module === "" ? undefined : slug(g.module),
  }));
  const edges: Edge[] = kept
    .map(([from, to]) => ({ from, to }))
    .sort((a, b) => `${a.from} ${a.to}`.localeCompare(`${b.from} ${b.to}`));

  const graph: Graph = { title: options.title, direction: "down", zones: zonesFor(groups), nodes, edges };
  assertDensity(graph, options.maxNodes, "--group-by type collapses same-type resources");
  return graph;
}

// Kubernetes objects -> a deployment topology.
//
//   kubectl get all,ingress,pvc -n NS -o json > snapshot.json   # a live cluster
//   kubectl kustomize k8s/overlays/prod > manifests.yaml        # a repo, offline

// Edges are read from the declarations themselves — selectors, backends,
// volume and env references — so a manifest directory works with no cluster.

import { YAML } from "bun";
import { assertDensity, type Edge, ExtractError, type Graph, type Node, slug } from "./model.ts";
import { manifest } from "../icons.ts";

type Obj = Record<string, unknown>;

function rec(value: unknown): Obj | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Obj)
    : undefined;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function at(root: unknown, ...path: string[]): unknown {
  let cursor: unknown = root;
  for (const key of path) {
    const next = rec(cursor);
    if (next === undefined) return undefined;
    cursor = next[key];
  }
  return cursor;
}

export interface K8sOptions {
  namespace?: string;
  config: boolean;
  maxNodes: number;
  title?: string;
}

const WORKLOADS = new Set([
  "CronJob",
  "DaemonSet",
  "Deployment",
  "Job",
  "Pod",
  "ReplicaSet",
  "StatefulSet",
]);
const CONFIG_KINDS = new Set(["ConfigMap", "Secret"]);
const TOPOLOGY_KINDS = new Set(["Ingress", "PersistentVolumeClaim", "Service"]);

export function parseObjects(raw: string): Obj[] {
  const trimmed = raw.trim();
  if (trimmed === "") throw new ExtractError("input is empty");
  let parsed: unknown;
  try {
    parsed = trimmed.startsWith("{") || trimmed.startsWith("[")
      ? JSON.parse(trimmed)
      : YAML.parse(trimmed);
  } catch (e) {
    throw new ExtractError(`input is neither JSON nor YAML: ${(e as Error).message}`);
  }
  const flat = arr(Array.isArray(parsed) ? parsed : [parsed])
    .flatMap((doc) => (str(at(doc, "kind"))?.endsWith("List") === true ? arr(at(doc, "items")) : [doc]))
    .map((doc) => rec(doc))
    .filter((doc): doc is Obj => doc !== undefined && str(at(doc, "kind")) !== undefined);
  if (flat.length === 0) {
    throw new ExtractError("no Kubernetes objects found — every document lacked a `kind`");
  }
  return flat;
}

interface Resource {
  id: string;
  kind: string;
  name: string;
  namespace: string;
  object: Obj;
}

function identify(object: Obj): { kind: string; name: string; namespace: string } {
  return {
    kind: str(at(object, "kind")) ?? "",
    name: str(at(object, "metadata", "name")) ?? "",
    namespace: str(at(object, "metadata", "namespace")) ?? "",
  };
}

const KIND_ICONS: Record<string, string> = { Ingress: "ingress", Secret: "secrets" };

// The container image names the software far better than the workload kind
// does: `postgres:16` is a database, `my-api:1.4` is whatever it is.
function iconFor(resource: Resource, icons = manifest()): string | undefined {
  const fixed = KIND_ICONS[resource.kind];
  if (fixed !== undefined) return fixed;
  if (!WORKLOADS.has(resource.kind)) return undefined;
  for (const container of containersOf(resource.object)) {
    const image = str(container.image) ?? "";
    const base = (image.split("@")[0] ?? "").split(":")[0] ?? "";
    const candidate = (base.split("/").pop() ?? "").toLowerCase();
    if (Object.hasOwn(icons, candidate)) return candidate;
  }
  return Object.hasOwn(icons, "kubernetes") ? "kubernetes" : undefined;
}

function podSpec(object: Obj): Obj | undefined {
  return rec(at(object, "spec", "template", "spec"))
    ?? rec(at(object, "spec", "jobTemplate", "spec", "template", "spec"))
    ?? (str(at(object, "kind")) === "Pod" ? rec(at(object, "spec")) : undefined);
}

function containersOf(object: Obj): Obj[] {
  const spec = podSpec(object);
  return [...arr(spec?.containers), ...arr(spec?.initContainers)]
    .map((c) => rec(c))
    .filter((c): c is Obj => c !== undefined);
}

function podLabels(object: Obj): Obj | undefined {
  return rec(at(object, "spec", "template", "metadata", "labels"))
    ?? (str(at(object, "kind")) === "Pod" ? rec(at(object, "metadata", "labels")) : undefined);
}

function selects(selector: Obj, labels: Obj | undefined): boolean {
  if (labels === undefined) return false;
  const entries = Object.entries(selector);
  return entries.length > 0 && entries.every(([k, v]) => labels[k] === v);
}

function replicaSuffix(object: Obj): { label: string; multiple: boolean } {
  const replicas = at(object, "spec", "replicas");
  const count = typeof replicas === "number" ? replicas : 1;
  return { label: count > 1 ? ` ×${count}` : "", multiple: count > 1 };
}

function collect(objects: Obj[], options: K8sOptions): Resource[] {
  const taken = new Set<string>();
  const wanted = (kind: string): boolean =>
    WORKLOADS.has(kind) || TOPOLOGY_KINDS.has(kind) || (options.config && CONFIG_KINDS.has(kind));
  return objects
    .map((object) => ({ object, ...identify(object) }))
    .filter((r) => wanted(r.kind))
    .filter((r) => options.namespace === undefined || r.namespace === options.namespace)
    .sort((a, b) => `${a.namespace}/${a.kind}/${a.name}`.localeCompare(`${b.namespace}/${b.kind}/${b.name}`))
    .map((r) => ({ ...r, id: uniqueId(r.kind, r.name, taken) }));
}

function uniqueId(kind: string, name: string, taken: Set<string>): string {
  const base = slug(`${kind}_${name}`);
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) candidate = `${base}_${n++}`;
  taken.add(candidate);
  return candidate;
}

function find(
  resources: Resource[],
  kind: string,
  name: string,
  namespace: string,
): Resource | undefined {
  return resources.find((r) => r.kind === kind && r.name === name && r.namespace === namespace);
}

function ingressEdges(ingress: Resource, all: Resource[]): Edge[] {
  const edges: Edge[] = [];
  const tls = arr(at(ingress.object, "spec", "tls")).length > 0;
  const scheme = tls ? "HTTPS" : "HTTP";
  for (const rule of arr(at(ingress.object, "spec", "rules"))) {
    const host = str(at(rule, "host")) ?? "*";
    for (const path of arr(at(rule, "http", "paths"))) {
      const service = str(at(path, "backend", "service", "name"));
      if (service === undefined) continue;
      const target = find(all, "Service", service, ingress.namespace);
      if (target === undefined) continue;
      edges.push({
        from: ingress.id,
        to: target.id,
        label: `${scheme} ${host}${str(at(path, "path")) ?? "/"}`,
        bold: true,
      });
    }
  }
  return edges;
}

function serviceEdges(service: Resource, all: Resource[]): Edge[] {
  const selector = rec(at(service.object, "spec", "selector"));
  if (selector === undefined) return [];
  const ports = arr(at(service.object, "spec", "ports"))
    .map((p) => `${at(p, "port")}→${at(p, "targetPort") ?? at(p, "port")}`)
    .join(", ");
  return all
    .filter((r) => WORKLOADS.has(r.kind) && r.namespace === service.namespace)
    .filter((r) => selects(selector, podLabels(r.object)))
    .map((r) => ({ from: service.id, to: r.id, label: ports === "" ? "selects" : `TCP ${ports}` }));
}

function mountPaths(object: Obj, volumeName: string): string[] {
  return containersOf(object)
    .flatMap((c) => arr(c.volumeMounts))
    .filter((m) => str(at(m, "name")) === volumeName)
    .map((m) => str(at(m, "mountPath")) ?? "")
    .filter((p) => p !== "");
}

function volumeEdges(workload: Resource, all: Resource[]): Edge[] {
  const edges: Edge[] = [];
  for (const volume of arr(at(podSpec(workload.object) ?? {}, "volumes"))) {
    const name = str(at(volume, "name")) ?? "";
    const targets: Array<[string, string | undefined]> = [
      ["PersistentVolumeClaim", str(at(volume, "persistentVolumeClaim", "claimName"))],
      ["ConfigMap", str(at(volume, "configMap", "name"))],
      ["Secret", str(at(volume, "secret", "secretName"))],
    ];
    for (const [kind, target] of targets) {
      if (target === undefined) continue;
      const found = find(all, kind, target, workload.namespace);
      if (found === undefined) continue;
      const paths = mountPaths(workload.object, name);
      edges.push({
        from: workload.id,
        to: found.id,
        label: paths.length === 0 ? "mounts" : `mounts ${paths.join(", ")}`,
      });
    }
  }
  return edges;
}

function envEdges(workload: Resource, all: Resource[]): Edge[] {
  const refs = new Map<string, string>();
  for (const container of containersOf(workload.object)) {
    for (const source of arr(container.envFrom)) {
      const configMap = str(at(source, "configMapRef", "name"));
      const secret = str(at(source, "secretRef", "name"));
      if (configMap !== undefined) refs.set(`ConfigMap/${configMap}`, "envFrom");
      if (secret !== undefined) refs.set(`Secret/${secret}`, "envFrom");
    }
    for (const variable of arr(container.env)) {
      const configMap = str(at(variable, "valueFrom", "configMapKeyRef", "name"));
      const secret = str(at(variable, "valueFrom", "secretKeyRef", "name"));
      if (configMap !== undefined) refs.set(`ConfigMap/${configMap}`, "env");
      if (secret !== undefined) refs.set(`Secret/${secret}`, "env");
    }
  }
  return [...refs.entries()].sort().flatMap(([key, how]) => {
    const [kind, name] = key.split("/") as [string, string];
    const found = find(all, kind, name, workload.namespace);
    return found === undefined ? [] : [{ from: workload.id, to: found.id, label: how }];
  });
}

// Nothing in a manifest declares "the api calls the database"; the only
// evidence is an env value naming the service. Matching whole DNS labels
// rather than substrings keeps that evidence, and refuses to invent an edge
// from a service name that merely happens to appear inside a longer word.
function serviceReference(value: string, services: Resource[]): { to: Resource; label: string } | undefined {
  const tokens = new Set(value.toLowerCase().split(/[^a-z0-9-]+/).filter((t) => t !== ""));
  const target = services.find((s) => s.name.length >= 3 && tokens.has(s.name.toLowerCase()));
  if (target === undefined) return undefined;
  const url = /^([a-z][a-z0-9+.-]*):\/\/[^\s]*?(?::(\d{2,5}))?(?:[/?#]|$)/.exec(value.trim());
  const scheme = url?.[1];
  const port = url?.[2];
  return {
    to: target,
    label: scheme === undefined ? "reads" : `${scheme}${port === undefined ? "" : ` ${port}`}`,
  };
}

function referenceEdges(workload: Resource, all: Resource[]): Edge[] {
  const services = all.filter((r) => r.kind === "Service" && r.namespace === workload.namespace);
  const edges = new Map<string, Edge>();
  for (const container of containersOf(workload.object)) {
    for (const variable of arr(container.env)) {
      const value = str(at(variable, "value"));
      if (value === undefined) continue;
      const hit = serviceReference(value, services);
      if (hit === undefined || hit.to.id === workload.id) continue;
      edges.set(hit.to.id, { from: workload.id, to: hit.to.id, label: hit.label });
    }
  }
  return [...edges.values()];
}

function ownerEdges(resource: Resource, all: Resource[]): Edge[] {
  return arr(at(resource.object, "metadata", "ownerReferences")).flatMap((ref) => {
    const kind = str(at(ref, "kind")) ?? "";
    const name = str(at(ref, "name")) ?? "";
    const owner = find(all, kind, name, resource.namespace);
    return owner === undefined ? [] : [{ from: owner.id, to: resource.id, label: "owns" }];
  });
}

export function buildGraph(objects: Obj[], options: K8sOptions): Graph {
  const resources = collect(objects, options);
  if (resources.length === 0) {
    throw new ExtractError(
      `no workloads, services, ingresses or claims found${
        options.namespace === undefined ? "" : ` in namespace ${options.namespace}`
      }`,
    );
  }

  const edges: Edge[] = [];
  for (const resource of resources) {
    if (resource.kind === "Ingress") edges.push(...ingressEdges(resource, resources));
    if (resource.kind === "Service") edges.push(...serviceEdges(resource, resources));
    if (WORKLOADS.has(resource.kind)) {
      edges.push(
        ...volumeEdges(resource, resources),
        ...envEdges(resource, resources),
        ...referenceEdges(resource, resources),
      );
    }
    edges.push(...ownerEdges(resource, resources));
  }

  const namespaces = [...new Set(resources.map((r) => r.namespace))].filter((n) => n !== "").sort();
  const nodes: Node[] = resources.map((resource) => {
    const replicas = replicaSuffix(resource.object);
    return {
      id: resource.id,
      label: `${resource.name}${replicas.label}`,
      tech: resource.kind,
      icon: iconFor(resource),
      multiple: replicas.multiple,
      zone: resource.namespace === "" ? undefined : slug(`ns_${resource.namespace}`),
    };
  });

  const graph: Graph = {
    title: options.title,
    direction: "down",
    zones: namespaces.map((name) => ({ id: slug(`ns_${name}`), label: `namespace ${name}` })),
    nodes,
    edges: dedupe(edges),
  };
  assertDensity(graph, options.maxNodes, "--namespace narrows to one boundary");
  return graph;
}

function dedupe(edges: Edge[]): Edge[] {
  const seen = new Map<string, Edge>();
  for (const edge of edges) {
    const key = `${edge.from}->${edge.to}:${edge.label ?? ""}`;
    if (!seen.has(key)) seen.set(key, edge);
  }
  return [...seen.values()].sort((a, b) =>
    `${a.from}${a.to}${a.label ?? ""}`.localeCompare(`${b.from}${b.to}${b.label ?? ""}`)
  );
}

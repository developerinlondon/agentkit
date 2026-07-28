import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bucket,
  buildGraph as buildDeps,
  dedupe,
  type DepsOptions,
  parseCruiser,
} from '../../skills/diagram/scripts/extract/deps.ts';
import { badgesFor, buildErd, parseTbls } from '../../skills/diagram/scripts/extract/schema.ts';
import {
  buildGraph as buildInfra,
  iconFor,
  parseState,
  reduceTransitive,
} from '../../skills/diagram/scripts/extract/infra.ts';
import { buildGraph as buildK8s, parseObjects } from '../../skills/diagram/scripts/extract/k8s.ts';
import { emit, ExtractError } from '../../skills/diagram/scripts/extract/model.ts';

const fixtures = join(import.meta.dir, 'fixtures');
const fixture = (name: string): string => readFileSync(join(fixtures, name), 'utf-8');

const depsOptions = (over: Partial<DepsOptions> = {}): DepsOptions => ({
  groupDepth: 1,
  externals: false,
  maxNodes: 12,
  ...over,
});

describe('dependency-cruiser -> module dependencies', () => {
  const cruised = parseCruiser(fixture('depcruise-storefront.json'));

  test('the fixture really does contain the duplicate entries the transform must survive', () => {
    // A capture without duplicates would let a double-counting bug pass; this
    // pins the property rather than trusting the tool to keep emitting it.
    const sources = (cruised.modules ?? []).map((m) => m.source);
    expect(sources.length).toBeGreaterThan(new Set(sources).size);
  });

  test('a file listed twice is counted once', () => {
    const graph = buildDeps(cruised, depsOptions({ focus: 'src' }));
    const store = graph.nodes.find((n) => n.id === 'store');
    expect(store?.tech).toBe('4 modules');
    expect(graph.nodes.map((n) => n.id)).toEqual(['api', 'domain', 'store', 'web']);
  });

  test('merging duplicates keeps the imports that only one copy carried', () => {
    const merged = dedupe([
      { source: 'a.ts', dependencies: [{ resolved: 'b.ts' }] },
      { source: 'a.ts', dependencies: [{ resolved: 'c.ts' }] },
    ]);
    expect(merged).toHaveLength(1);
    expect((merged[0]?.dependencies ?? []).map((d) => d.resolved).sort()).toEqual(['b.ts', 'c.ts']);
  });

  test('a two-way pair is marked as the cycle it is', () => {
    const graph = buildDeps(cruised, depsOptions({ focus: 'src' }));
    const cyclic = graph.edges.filter((e) => e.bold === true).map((e) => `${e.from}->${e.to}`);
    expect(cyclic.sort()).toEqual(['domain->store', 'store->domain']);
  });

  test('a one-way pair is not', () => {
    const graph = buildDeps(cruised, depsOptions({ focus: 'src' }));
    expect(graph.edges.find((e) => e.from === 'web')?.bold).toBe(false);
  });

  test('core builtins and packages stay out unless asked for', () => {
    const graph = buildDeps(cruised, depsOptions({ focus: 'src' }));
    expect(graph.nodes.map((n) => n.label)).not.toContain('node builtins');
    expect(graph.nodes.map((n) => n.label)).not.toContain('zod');
  });

  test('every file of a package collapses to the package', () => {
    // The fixture imports one zod entry point that pulls in twenty more files;
    // drawn per-file they would swamp the figure they were meant to annotate.
    const graph = buildDeps(cruised, depsOptions({ focus: 'src', externals: true, maxNodes: 20 }));
    const zod = graph.nodes.filter((n) => n.label === 'zod');
    expect(zod).toHaveLength(1);
    expect(graph.nodes.map((n) => n.label)).toContain('@sindresorhus/is');
  });

  test('an external package sits in a zone drawn as outside your control', () => {
    const graph = buildDeps(cruised, depsOptions({ focus: 'src', externals: true, maxNodes: 20 }));
    expect(graph.zones.find((z) => z.id === 'external')?.dashed).toBe(true);
    expect(graph.edges.filter((e) => e.dashed === true).length).toBeGreaterThan(0);
  });

  test('edges into a package carry no count, so the labels cannot stack on each other', () => {
    // Several components reach the same few packages; labelling every one of
    // those edges puts three counts in the same place and none of them reads.
    const graph = buildDeps(cruised, depsOptions({ focus: 'src', externals: true, maxNodes: 20 }));
    const external = graph.edges.filter((e) => e.dashed === true);
    const internal = graph.edges.filter((e) => e.dashed !== true);
    expect(external.length).toBeGreaterThan(2);
    expect(external.every((e) => e.label === undefined)).toBe(true);
    expect(internal.every((e) => e.label?.includes('import') === true)).toBe(true);
  });

  test('a scoped package is one node, not a package inside a folder', () => {
    const graph = buildDeps(cruised, depsOptions({ focus: 'src', externals: true, maxNodes: 20 }));
    expect(graph.zones.map((z) => z.id)).not.toContain('external_sindresorhus');
  });

  test('a core module is never mistaken for a top-level component of the project', () => {
    const graph = buildDeps(cruised, depsOptions({ maxNodes: 30 }));
    expect(graph.nodes.map((n) => n.id)).toEqual(['src']);
  });

  test('bucket sorts each kind of module entry to where it belongs', () => {
    const o = depsOptions({ externals: true });
    expect(bucket('fs', { coreModule: true }, o)).toBe('external/node builtins');
    expect(bucket('node_modules/zod/v3/x.cjs', {}, o)).toBe('external/zod');
    expect(bucket('bun', { couldNotResolve: true }, o)).toBe('external/bun');
    expect(bucket('src/api/routes.ts', {}, { ...o, focus: 'src' })).toBe('api');
    expect(bucket(undefined, {}, o)).toBeUndefined();
  });

  test('a file shallower than the requested depth groups under its own name', () => {
    expect(bucket('src/main.ts', {}, depsOptions({ focus: 'src', groupDepth: 2 }))).toBe('main.ts');
  });

  test('a focus that matches nothing says so instead of drawing an empty figure', () => {
    expect(() => buildDeps(cruised, depsOptions({ focus: 'nope' }))).toThrow(/no project modules matched/);
  });

  test('a cruise that found nothing is refused with the reason it finds nothing', () => {
    expect(() => parseCruiser('{"modules":[]}')).toThrow(/cruised nothing/);
    expect(() => parseCruiser('{"modules":[]}')).toThrow(/glob/);
  });

  test('input that is not cruiser output is named as such', () => {
    expect(() => parseCruiser('{"tables":[]}')).toThrow(/no `modules` array/);
    expect(() => parseCruiser('not json')).toThrow(/not JSON/);
  });
});

describe('tbls -> ERD', () => {
  const schema = parseTbls(fixture('tbls-publishing.json'));
  const erd = buildErd(schema, { maxNodes: 12 });

  test('a column carrying two constraints gets both badges', () => {
    const table = (schema.tables ?? []).find((t) => t.name === 'page_tag');
    expect(badgesFor(table as never, 'page_id')).toEqual(['primary_key', 'foreign_key']);
    expect(erd).toContain('"page_id": TEXT {constraint: [primary_key; foreign_key]}');
  });

  test('a plain column gets no badge at all', () => {
    expect(erd).toContain('"body_md": TEXT\n');
  });

  test('column types are reproduced verbatim — the figure is read as a schema', () => {
    expect(erd).toContain('"id": INTEGER {constraint: primary_key}');
  });

  test('a nullable foreign key is drawn optional and a NOT NULL one required', () => {
    // revision.author_id is nullable, revision.page_id is not; tbls reports
    // that as the parent cardinality and the crow's foot must not level them.
    expect(erd).toMatch(/"account"\."id" -> "revision"\."author_id".*\n.*cf-one\n/);
    expect(erd).toMatch(/"page"\."id" -> "revision"\."page_id".*\n.*cf-one-required\n/);
  });

  test('edges attach to the specific column, never table to table', () => {
    for (const line of erd.split('\n').filter((l) => l.includes('->'))) {
      expect(line).toMatch(/^"[^"]+"\."[^"]+" -> "[^"]+"\."[^"]+"/);
    }
  });

  test('a reserved word used as a table or column name still compiles', () => {
    const hostile = buildErd(
      {
        driver: { name: 'postgres' },
        tables: [{
          name: 'style',
          columns: [{ name: 'label', type: 'text' }, { name: 'shape', type: 'text' }],
          constraints: [{ type: 'PRIMARY KEY', columns: ['label'] }],
        }],
      },
      { maxNodes: 12 },
    );
    expect(hostile).toContain('"style": {');
    expect(hostile).toContain('"label": text {constraint: primary_key}');
  });

  test('--tables selects a subsystem and drops the relations that left with it', () => {
    const pair = buildErd(schema, { tables: ['account', 'site'], maxNodes: 12 });
    expect(pair).toContain('"site": {');
    expect(pair).not.toContain('"page": {');
    expect(pair.match(/->/g) ?? []).toHaveLength(1);
  });

  test('--tables naming a table the schema lacks is a mistake, not an empty diagram', () => {
    expect(() => buildErd(schema, { tables: ['ghost'], maxNodes: 12 })).toThrow(/does not have: ghost/);
  });

  test('a schema wider than the budget is refused with the lever that narrows it', () => {
    expect(() => buildErd(schema, { maxNodes: 3 })).toThrow(/6 tables.*--tables/s);
  });

  test('an unrecognised cardinality is refused rather than guessed at', () => {
    const odd = {
      tables: [
        { name: 'a', columns: [{ name: 'id', type: 'int' }] },
        { name: 'b', columns: [{ name: 'a_id', type: 'int' }] },
      ],
      relations: [{
        table: 'b',
        columns: ['a_id'],
        cardinality: 'several',
        parent_table: 'a',
        parent_columns: ['id'],
      }],
    };
    expect(() => buildErd(odd, { maxNodes: 12 })).toThrow(/unknown tbls cardinality "several"/);
  });

  test('input that is not tbls output is named as such', () => {
    expect(() => parseTbls('{"modules":[]}')).toThrow(/no `tables`/);
  });
});

describe('tofu show -json -> deployment topology', () => {
  const state = parseState(fixture('tofu-state.json'));
  const graph = buildInfra(state, { groupByType: false, reduce: true, maxNodes: 12 });

  test('no attribute value from the state reaches the diagram', () => {
    // State holds secrets in plain text. The transform reads addresses and
    // dependencies only, and this is the assertion that keeps it that way.
    const values = [...fixture('tofu-state.json').matchAll(/"content_sha256": "([^"]+)"/g)].map((m) => m[1]);
    expect(values.length).toBeGreaterThan(0);
    const d2 = emit(graph, 'test');
    for (const value of values) expect(d2).not.toContain(value as string);
    expect(d2).not.toContain('content_base64sha256');
  });

  test('a nested module becomes a zone nested inside its parent', () => {
    const backup = graph.zones.find((z) => z.label === 'module.store.module.backup');
    expect(backup?.parent).toBe(graph.zones.find((z) => z.label === 'module.store')?.id);
  });

  test('counted instances collapse to one node carrying the count', () => {
    const manifest = graph.nodes.find((n) => n.label.startsWith('node_manifest'));
    expect(manifest?.label).toBe('node_manifest ×2');
    expect(manifest?.multiple).toBe(true);
  });

  test('an indexed address still resolves to the node that stands for it', () => {
    const manifest = graph.nodes.find((n) => n.label.startsWith('node_manifest'));
    expect(graph.edges.some((e) => e.to === manifest?.id)).toBe(true);
  });

  test('an edge a longer path already implies is dropped', () => {
    // State records every ancestor, so the root random_pet arrives as a direct
    // dependency of a resource two modules down that only reaches it through
    // bucket_policy.
    const dense = buildInfra(state, { groupByType: false, reduce: false, maxNodes: 12 });
    expect(dense.edges.length).toBeGreaterThan(graph.edges.length);
    const retention = graph.nodes.find((n) => n.label === 'retention');
    const intoRetention = graph.edges.filter((e) => e.to === retention?.id);
    expect(intoRetention).toHaveLength(1);
  });

  test('transitive reduction keeps the shortcut when no longer path exists', () => {
    expect(reduceTransitive([['a', 'b'], ['b', 'c'], ['a', 'c']])).toEqual([['a', 'b'], ['b', 'c']]);
    expect(reduceTransitive([['a', 'b'], ['a', 'c']])).toEqual([['a', 'b'], ['a', 'c']]);
  });

  test('a cycle does not send the reduction into an infinite walk', () => {
    expect(reduceTransitive([['a', 'b'], ['b', 'a']])).toEqual([['a', 'b'], ['b', 'a']]);
  });

  test('--group-by type collapses a module\'s same-type resources', () => {
    const byType = buildInfra(state, { groupByType: true, reduce: true, maxNodes: 12 });
    expect(byType.nodes.length).toBeLessThan(graph.nodes.length);
    expect(byType.nodes.find((n) => n.label === 'local_file ×3')).toBeDefined();
  });

  test('the vendored stencil is chosen from the most specific type that has one', () => {
    const icons = { aws: { file: '' }, 'aws-rds': { file: '' }, kubernetes: { file: '' } } as never;
    const of = (type: string, provider: string): string | undefined =>
      iconFor({ address: 'x', type, provider_name: `registry.opentofu.org/hashicorp/${provider}` }, icons);
    expect(of('aws_rds_cluster', 'aws')).toBe('aws-rds');
    expect(of('aws_ecs_service', 'aws')).toBe('aws');
    expect(of('kubernetes_deployment', 'kubernetes')).toBe('kubernetes');
    expect(of('local_file', 'local')).toBeUndefined();
  });

  test('a data source is not part of the topology it reads', () => {
    const withData = {
      values: {
        root_module: {
          resources: [
            { address: 'data.aws_ami.x', mode: 'data', type: 'aws_ami', name: 'x' },
            { address: 'aws_instance.y', mode: 'managed', type: 'aws_instance', name: 'y' },
          ],
        },
      },
    };
    const built = buildInfra(withData, { groupByType: false, reduce: true, maxNodes: 12 });
    expect(built.nodes).toHaveLength(1);
    expect(built.nodes[0]?.label).toBe('y');
  });

  test('a plan file is diagnosed rather than silently drawn empty', () => {
    expect(() => parseState('{"planned_values":{"root_module":{}}}')).toThrow(/planned_values/);
  });
});

describe('Kubernetes objects -> deployment topology', () => {
  const objects = parseObjects(fixture('k8s-publishing.yaml'));
  const graph = buildK8s(objects, { config: false, maxNodes: 20 });
  const edge = (from: string, to: string): string | undefined =>
    graph.edges.find((e) => e.from.includes(from) && e.to.includes(to))?.label;

  test('a multi-document manifest file is read as many objects', () => {
    expect(objects.length).toBeGreaterThan(10);
  });

  test('a kubectl List envelope unwraps to the same objects', () => {
    const list = JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objects });
    expect(parseObjects(list)).toHaveLength(objects.length);
  });

  test('an ingress edge carries the real host, path and scheme', () => {
    expect(edge('ingress_publish', 'service_publish_api')).toBe('HTTPS pages.example.com/');
  });

  test('a service reaches its workload through the selector, with the port mapping', () => {
    expect(edge('service_publish_api', 'deployment_publish_api')).toBe('TCP 80→8080');
  });

  test('a selector matching nothing draws no edge rather than a wrong one', () => {
    const orphan = buildK8s(
      [
        { kind: 'Service', metadata: { name: 's', namespace: 'n' }, spec: { selector: { app: 'absent' } } },
        {
          kind: 'Deployment',
          metadata: { name: 'd', namespace: 'n' },
          spec: { selector: {}, template: { metadata: { labels: { app: 'present' } } } },
        },
      ],
      { config: false, maxNodes: 12 },
    );
    expect(orphan.edges).toHaveLength(0);
  });

  test('a service call is derived from the env value that names it, with its protocol', () => {
    expect(edge('deployment_publish_api', 'service_publish_db')).toBe('postgres 5432');
    expect(edge('deployment_publish_api', 'service_publish_cache')).toBe('redis 6379');
  });

  test('a service name buried inside a longer word is not an edge', () => {
    const near = buildK8s(
      [
        { kind: 'Service', metadata: { name: 'api', namespace: 'n' }, spec: { selector: { a: 'b' } } },
        {
          kind: 'Deployment',
          metadata: { name: 'w', namespace: 'n' },
          spec: {
            template: {
              metadata: { labels: {} },
              spec: { containers: [{ name: 'c', env: [{ name: 'X', value: 'rapidapikey' }] }] },
            },
          },
        },
      ],
      { config: false, maxNodes: 12 },
    );
    expect(near.edges).toHaveLength(0);
  });

  test('a volume edge names the path it is mounted at', () => {
    expect(edge('deployment_publish_api', 'persistentvolumeclaim_publish_artifacts'))
      .toBe('mounts /var/lib/artifacts');
  });

  test('the icon comes from the image, so a database looks like its database', () => {
    expect(graph.nodes.find((n) => n.id === 'statefulset_publish_db')?.icon).toBe('postgres');
    expect(graph.nodes.find((n) => n.id === 'deployment_publish_cache')?.icon).toBe('redis');
    expect(graph.nodes.find((n) => n.id === 'deployment_publish_api')?.icon).toBe('kubernetes');
  });

  test('replicas are one node carrying the count', () => {
    const api = graph.nodes.find((n) => n.id === 'deployment_publish_api');
    expect(api?.label).toBe('publish-api ×3');
    expect(api?.multiple).toBe(true);
  });

  test('config and secrets are left out until asked for', () => {
    expect(graph.nodes.map((n) => n.tech)).not.toContain('Secret');
    const withConfig = buildK8s(objects, { config: true, maxNodes: 20 });
    expect(withConfig.nodes.map((n) => n.tech)).toContain('Secret');
    expect(withConfig.edges.some((e) => e.label === 'envFrom')).toBe(true);
  });

  test('the namespace is the boundary, and --namespace narrows to one', () => {
    expect(graph.zones.map((z) => z.label)).toEqual(['namespace publishing']);
    expect(() => buildK8s(objects, { namespace: 'other', config: false, maxNodes: 20 }))
      .toThrow(/namespace other/);
  });

  test('ownerReferences from a live capture become containment edges', () => {
    const live = buildK8s(
      [
        { kind: 'Deployment', metadata: { name: 'd', namespace: 'n' }, spec: {} },
        {
          kind: 'ReplicaSet',
          metadata: { name: 'r', namespace: 'n', ownerReferences: [{ kind: 'Deployment', name: 'd' }] },
          spec: {},
        },
      ],
      { config: false, maxNodes: 12 },
    );
    expect(live.edges).toEqual([{ from: 'deployment_d', to: 'replicaset_r', label: 'owns' }]);
  });

  test('input that is neither JSON nor a manifest is refused', () => {
    expect(() => parseObjects('')).toThrow(/empty/);
    expect(() => parseObjects('{"a": 1}')).toThrow(/no Kubernetes objects/);
  });
});

describe('every extractor refuses rather than half-draws', () => {
  test('each failure is an ExtractError, so the CLI reports it as a message', () => {
    const cases = [
      () => parseCruiser('nope'),
      () => parseTbls('nope'),
      () => parseState('nope'),
      () => parseObjects('\t'),
    ];
    for (const run of cases) expect(run).toThrow(ExtractError);
  });
});

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

// What the CLI passes when the caller gives nothing but an input file.
const DEFAULT_DEPS: DepsOptions = { groupDepth: 2, externals: false, maxNodes: 12 };

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
    const graph = buildDeps(cruised, DEFAULT_DEPS);
    expect(graph.nodes.map((n) => n.label)).toEqual(['api', 'domain', 'store', 'web']);
  });

  test('the flags the usage line documents produce the figure it promises', () => {
    // A project rooted at one top directory is the layout the usage example
    // shows; at depth 1 every module bucketed into a single box.
    const graph = buildDeps(cruised, DEFAULT_DEPS);
    expect(graph.nodes.length).toBeGreaterThan(1);
    expect(graph.edges.length).toBeGreaterThan(0);
  });

  test('a grouping that collapses everything into one box is refused, not drawn', () => {
    expect(() => buildDeps(cruised, depsOptions({ groupDepth: 1 })))
      .toThrow(/single box "src".*--group-depth/s);
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

// Two tables joined by one foreign key, with the cardinalities under test —
// the smallest schema that exercises both crow's-foot ends.
const related = (child: string | undefined, parent: string | undefined) => ({
  tables: [
    { name: 'a', columns: [{ name: 'id', type: 'int' }] },
    { name: 'b', columns: [{ name: 'a_id', type: 'int' }] },
  ],
  relations: [{
    table: 'b',
    columns: ['a_id'],
    cardinality: child,
    parent_table: 'a',
    parent_columns: ['id'],
    parent_cardinality: parent,
  }],
});

describe('tbls -> ERD', () => {
  const schema = parseTbls(fixture('tbls-publishing.json'));
  const erd = buildErd(schema, { maxNodes: 12 });

  test('a column carrying two constraints gets both badges', () => {
    const table = (schema.tables ?? []).find((t) => t.name === 'page_tag');
    expect(badgesFor(table as never, 'page_id')).toEqual(['primary_key', 'foreign_key']);
    expect(erd).toContain('"page_id": "TEXT" {constraint: [primary_key; foreign_key]}');
  });

  test('a plain column gets no badge at all', () => {
    expect(erd).toContain('"body_md": "TEXT"\n');
  });

  test('column types are reproduced verbatim — the figure is read as a schema', () => {
    // Verbatim means quoted, not raw: the text between the quotes is exactly
    // what the database declared, and d2 renders a quoted type unchanged.
    expect(erd).toContain('"id": "INTEGER" {constraint: primary_key}');
  });

  test('a column type cannot close the table and declare nodes of its own', () => {
    // SQLite stores a declared type as free text, so this reaches the transform
    // from a real capture — the payload ends the sql_table block, declares a
    // node and an edge that exist in no database, then reopens a block to
    // swallow the columns that follow.
    const payload = 'TEXT}\nINJECTED: "PWNED" {\n  shape: circle\n}\nINJECTED -> "page": "FAKE EDGE"\nzzz: {\n  shape: sql_table\n  "c": TEXT';
    const hostile = buildErd(
      {
        driver: { name: 'sqlite' },
        tables: [{ name: 'page', columns: [{ name: 'id', type: payload }] }],
      },
      { maxNodes: 12 },
    );
    // The payload survives as text inside one quoted value — that is what
    // verbatim means — but it is no longer structure: every one of its
    // newlines is now the two characters `\n`, so it cannot leave its line.
    expect(hostile).toContain('INJECTED');
    expect(hostile.match(/^\s*shape: sql_table$/gm) ?? []).toHaveLength(1);
    expect(hostile.match(/^\s*shape: circle$/gm) ?? []).toHaveLength(0);
    expect(hostile.match(/^\S.* -> /gm) ?? []).toHaveLength(0);
    const payloadLines = hostile.split('\n').filter((l) => l.includes('INJECTED'));
    expect(payloadLines).toHaveLength(1);
    expect(payloadLines[0]?.startsWith('  "id": "')).toBe(true);
  });

  test('a driver name cannot end the provenance comment and become source', () => {
    const hostile = buildErd(
      {
        driver: { name: 'sqlite\nINJECTED: "PWNED"' },
        tables: [{ name: 't', columns: [{ name: 'c', type: 'TEXT' }] }],
      },
      { maxNodes: 12 },
    );
    // It stays inside the comment; what it must not do is start a new line.
    const lines = hostile.split('\n');
    expect(lines[0]?.startsWith('# derived from tbls JSON')).toBe(true);
    expect(lines.filter((l) => l.includes('INJECTED'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('INJECTED'))[0]?.startsWith('#')).toBe(true);
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
    expect(hostile).toContain('"label": "text" {constraint: primary_key}');
  });

  test('a type or name carrying $ cannot reach d2 as a variable reference', () => {
    // d2 substitutes ${...} inside double quotes, so an unescaped $ aborts the
    // render on a variable nothing declared.
    const hostile = buildErd(
      {
        driver: { name: 'postgres' },
        tables: [{ name: 'tbl$1', columns: [{ name: 'col${x}', type: 'numeric${y}' }] }],
      },
      { maxNodes: 12 },
    );
    expect(hostile).toContain('"tbl\\$1"');
    expect(hostile).toContain('"col\\${x}"');
    expect(hostile).toContain('"numeric\\${y}"');
    expect(hostile).not.toMatch(/[^\\]\$\{/);
  });

  test('the cf-many-required arrowhead is reachable, though no live tbls emits it', () => {
    // tbls's detectCardinality can only derive zero_or_one, zero_or_more and
    // exactly_one, so regenerating the fixture will never cover one_or_more.
    const built = buildErd(related('one_or_more', 'exactly_one'), { maxNodes: 12 });
    expect(built).toContain('target-arrowhead.shape: cf-many-required');
    expect(built).toContain('"1..N"');
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

  test('an unrecognised cardinality is refused on both the arrowhead and the label', () => {
    // The two lookups used to disagree: one threw, the other quietly dropped
    // the label. A derived figure states what the schema says or nothing.
    expect(() => buildErd(related('several', 'exactly_one'), { maxNodes: 12 }))
      .toThrow(/unknown tbls cardinality "several"/);
    expect(() => buildErd(related('zero_or_more', 'a few'), { maxNodes: 12 }))
      .toThrow(/unknown tbls cardinality "a few"/);
  });

  test('a cardinality tbls could not derive draws no glyph and no label', () => {
    // tbls tags the field omitempty, so a relation it could not classify has
    // no key at all. Defaulting the crow's foot would state a modality the
    // schema never did — the edge is drawn, the claim is not.
    const built = buildErd(related(undefined, undefined), { maxNodes: 12 });
    expect(built).toContain('"a"."id" -> "b"."a_id"\n');
    expect(built).not.toContain('arrowhead');
    expect(built).not.toContain('0..N');
  });

  test('one end known and the other not draws only the end that is known', () => {
    const built = buildErd(related('zero_or_more', undefined), { maxNodes: 12 });
    expect(built).toContain('target-arrowhead.shape: cf-many');
    expect(built).not.toContain('source-arrowhead');
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

describe('container names that slug alike stay distinct', () => {
  // slug() maps every separator run to `_`, so `a-b` and `a_b` land on one id.
  // Two containers sharing an id is the silent failure: d2 merges same-key
  // blocks, the last label wins, and one namespace vanishes with its contents
  // shown living somewhere they are not.
  const service = (namespace: string, name: string) => ({
    kind: 'Service',
    metadata: { name, namespace },
    spec: { selector: { app: name } },
  });

  test('k8s keeps two namespaces that slug alike apart', () => {
    const graph = buildK8s([service('a-b', 'svc-one'), service('a_b', 'svc-two')], {
      config: false,
      maxNodes: 12,
    });
    expect(new Set(graph.zones.map((z) => z.id)).size).toBe(2);
    expect(graph.zones.map((z) => z.label).sort()).toEqual(['namespace a-b', 'namespace a_b']);
    const emitted = emit(graph, 'test');
    expect(emitted).toContain('namespace a-b');
    expect(emitted).toContain('namespace a_b');
  });

  test('infra keeps two modules that slug alike apart', () => {
    const resource = (module: string) => ({
      address: `${module}.local_file.x`,
      mode: 'managed',
      type: 'local_file',
      name: 'x',
    });
    const graph = buildInfra(
      {
        values: {
          root_module: {
            child_modules: [
              { address: 'module.a-b', resources: [resource('module.a-b')] },
              { address: 'module.a_b', resources: [resource('module.a_b')] },
            ],
          },
        },
      },
      { groupByType: false, reduce: true, maxNodes: 12 },
    );
    expect(new Set(graph.zones.map((z) => z.id)).size).toBe(2);
    expect(() => emit(graph, 'test')).not.toThrow();
  });

  test('deps keeps two directories that slug alike apart', () => {
    const mod = (source: string) => ({ source, dependencies: [] });
    const graph = buildDeps(
      { modules: [mod('src/a-b/one.ts'), mod('src/a_b/two.ts'), mod('src/c/three.ts')] },
      depsOptions({ focus: 'src', groupDepth: 2 }),
    );
    expect(new Set(graph.zones.map((z) => z.id)).size).toBe(graph.zones.length);
    expect(() => emit(graph, 'test')).not.toThrow();
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

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { offValueLine, readOverride } from './override.ts';
import type { Source } from './sources.ts';
import type { Store } from './store.ts';
import {
  containingWorkTree,
  repoVisibility,
  type Target,
  TARGET_PRIVATE_OVERRIDE,
} from './visibility.ts';

export type { Target };

export type Probe = (dir: string, env: Record<string, string | undefined>) => Promise<Target>;

export interface GuardRequest {
  store: Store;
  cwd: string;
  home: string;
  env: Record<string, string | undefined>;
  project: readonly Source[];
  machine: readonly Source[];
  probe?: Probe;
}

export interface GuardResult {
  errors: string[];
  report: string[];
}

// Where a snapshot would land, and what to say about it: the repository being
// vendored into, or the machine store when that sits inside a work tree.
interface Destination {
  sources: readonly Source[];
  dir: string;
  publicWhere: string;
  unknownWhere: string;
  advice: string;
}

function machineScope(store: Store, home: string): string {
  return 'Declare the source at the machine level in ~/.config/agentkit/config.yaml, where its '
    + `snapshot stays in ${store.tree('user', home)} and is committed to nothing`;
}

const MOVE_STORE = 'Move the machine store out of that work tree, or declare the source '
  + 'visibility: public';

function missingKey(source: Source, store: Store): string {
  return `${source.name}: visibility is not declared in ${source.origin} — vendoring commits this `
    + `source's ${store.plural} into the repository, so a source a repository vendors must say `
    + 'whether they are public or private. Add visibility: public or visibility: private.';
}

function intoPublic(source: Source, target: Target, store: Store, into: Destination): string {
  return `${source.name}: refusing to vendor a private source into ${into.publicWhere} — `
    + `${target.detail}, and vendoring would commit ${source.name}'s ${store.plural} into it. `
    + `${into.advice}.`;
}

// Fail closed. A target that cannot be shown to be private is treated as
// public, because the opposite assumes privacy on no evidence — and that
// assumption costs a leak where this one costs one environment variable.
function intoUnknown(
  source: Source,
  target: Target,
  into: Destination,
  refusedOverride: string,
): string {
  const advice = `${into.advice.charAt(0).toLowerCase()}${into.advice.slice(1)}`;
  return `${source.name}: refusing to vendor a private source into ${into.unknownWhere} — `
    + `${target.detail}. ${refusedOverride}Set ${TARGET_PRIVATE_OVERRIDE}=1 on the command if you `
    + `know it is private, or ${advice}.`;
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

// The deepest part of the machine store that exists, since git can only be
// asked about a directory that is there.
function storeAnchor(store: Store, home: string): string | undefined {
  return [store.tree('user', home), join(home, '.agentkit'), home].find(isDirectory);
}

// The repository store is gated unconditionally: a directory with no remote
// today gets one tomorrow, and the snapshot is already on disk by then. The
// machine store is gated only when it sits inside a work tree, because that is
// the only way anything there reaches a forge — and its sources default to
// private, so gating it unconditionally would refuse the ordinary machine.
async function machineStore(
  request: GuardRequest,
  timeoutEnv: Record<string, string | undefined>,
): Promise<Destination | undefined> {
  if (request.machine.length === 0) return undefined;
  const store = request.store;
  const anchor = storeAnchor(store, request.home);
  if (anchor === undefined) return undefined;
  const tree = await containingWorkTree(anchor, timeoutEnv);
  if (tree === undefined) return undefined;
  const at = store.tree('user', request.home);
  return {
    sources: request.machine,
    dir: tree,
    publicWhere: `the machine store at ${at}, which sits inside the public git work tree ${tree}`,
    unknownWhere: `the machine store at ${at}, which sits inside the git work tree ${tree}, `
      + 'whose visibility could not be determined',
    advice: MOVE_STORE,
  };
}

// The forge is asked once per store, and only when a private source is actually
// declared for it: a public source is vendored into anything, and asking anyway
// would make an offline machine fail a sync that was never at risk.
async function judge(
  into: Destination,
  request: GuardRequest,
  probe: Probe,
): Promise<GuardResult> {
  const declaredPrivate = into.sources.filter((source) => source.visibility === 'private');
  if (declaredPrivate.length === 0) return { errors: [], report: [] };

  const target = await probe(into.dir, request.env);
  if (target.visibility === 'private') return { errors: [], report: [] };
  if (target.visibility === 'public') {
    return {
      errors: declaredPrivate.map((source) => intoPublic(source, target, request.store, into)),
      report: [],
    };
  }

  const override = readOverride(request.env[TARGET_PRIVATE_OVERRIDE]);
  if (override.state === 'granted') {
    return {
      errors: [],
      report: declaredPrivate.map((source) =>
        `${TARGET_PRIVATE_OVERRIDE} was set deliberately: ${source.name} was vendored into a `
        + `target whose visibility could not be determined — ${target.detail}.`
      ),
    };
  }

  const refused = override.state === 'off'
    ? `${offValueLine(TARGET_PRIVATE_OVERRIDE, override.value)}, so the guard still applies. `
    : '';
  return {
    errors: declaredPrivate.map((source) => intoUnknown(source, target, into, refused)),
    report: [],
  };
}

// The override supplies knowledge the tool lacked — it never contradicts
// knowledge the tool has. A target the forge said is public stays refused with
// it set, because that case is the leak rather than the inconvenience.
export async function guardTargets(request: GuardRequest): Promise<GuardResult> {
  const probe = request.probe ?? repoVisibility;
  const errors = request.project
    .filter((source) => source.visibility === undefined)
    .map((source) => missingKey(source, request.store));
  const report: string[] = [];

  const repository: Destination = {
    sources: request.project,
    dir: request.cwd,
    publicWhere: 'a public repository',
    unknownWhere: 'a repository whose visibility could not be determined',
    advice: machineScope(request.store, request.home),
  };

  for (const into of [repository, await machineStore(request, request.env)]) {
    if (into === undefined) continue;
    const verdict = await judge(into, request, probe);
    errors.push(...verdict.errors);
    report.push(...verdict.report);
  }

  return { errors, report };
}

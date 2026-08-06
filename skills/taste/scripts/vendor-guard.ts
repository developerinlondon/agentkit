import { offValueLine, readOverride } from './override.ts';
import type { TasteSource } from './sources.ts';
import { repoVisibility, type Target, TARGET_PRIVATE_OVERRIDE } from './visibility.ts';

export type { Target };

export interface GuardRequest {
  cwd: string;
  env: Record<string, string | undefined>;
  sources: readonly TasteSource[];
  probe?: (cwd: string, env: Record<string, string | undefined>) => Promise<Target>;
}

export interface GuardResult {
  errors: string[];
  report: string[];
}

const MACHINE_SCOPE = 'Declare the source at the machine level in ~/.config/agentkit/config.yaml, '
  + 'where its snapshot stays in ~/.agentkit/tastes/ and is committed to nothing';

function missingKey(source: TasteSource): string {
  return `${source.name}: visibility is not declared in ${source.origin} — vendoring commits this `
    + 'source\'s tastes into the repository, so a source a repository vendors must say whether '
    + 'they are public or private. Add visibility: public or visibility: private.';
}

function intoPublic(source: TasteSource, target: Target): string {
  return `${source.name}: refusing to vendor a private source into a public repository — `
    + `${target.detail}, and vendoring would commit ${source.name}'s tastes into it. `
    + `${MACHINE_SCOPE}.`;
}

// Fail closed. A repository that cannot be shown to be private is treated as
// public, because the opposite assumes privacy on no evidence — and that
// assumption costs a leak where this one costs one environment variable.
function intoUnknown(source: TasteSource, target: Target, refusedOverride: string): string {
  return `${source.name}: refusing to vendor a private source into a repository whose visibility `
    + `could not be determined — ${target.detail}. ${refusedOverride}Set `
    + `${TARGET_PRIVATE_OVERRIDE}=1 on the command if you know this repository is private, or `
    + `${MACHINE_SCOPE.charAt(0).toLowerCase()}${MACHINE_SCOPE.slice(1)}.`;
}

// The forge is asked once, and only when a private source is actually declared
// for this repository: a public source is vendored into anything, and asking
// anyway would make an offline machine fail a sync that was never at risk.
async function targetOf(request: GuardRequest): Promise<Target> {
  return await (request.probe ?? repoVisibility)(request.cwd, request.env);
}

// The override supplies knowledge the tool lacked — it never contradicts
// knowledge the tool has. A target the forge said is public stays refused with
// it set, because that case is the leak rather than the inconvenience.
export async function guardTargets(request: GuardRequest): Promise<GuardResult> {
  const errors = request.sources
    .filter((source) => source.visibility === undefined)
    .map(missingKey);
  const declaredPrivate = request.sources.filter((source) => source.visibility === 'private');
  if (declaredPrivate.length === 0) return { errors, report: [] };

  const target = await targetOf(request);
  if (target.visibility === 'private') return { errors, report: [] };
  if (target.visibility === 'public') {
    return { errors: [...errors, ...declaredPrivate.map((source) => intoPublic(source, target))], report: [] };
  }

  const override = readOverride(request.env[TARGET_PRIVATE_OVERRIDE]);
  if (override.state === 'granted') {
    return {
      errors,
      report: declaredPrivate.map((source) =>
        `${TARGET_PRIVATE_OVERRIDE} was set deliberately: ${source.name} was vendored into a `
        + `repository whose visibility could not be determined — ${target.detail}.`
      ),
    };
  }

  const refused = override.state === 'off'
    ? `${offValueLine(TARGET_PRIVATE_OVERRIDE, override.value)}, so the guard still applies. `
    : '';
  return {
    errors: [...errors, ...declaredPrivate.map((source) => intoUnknown(source, target, refused))],
    report: [],
  };
}

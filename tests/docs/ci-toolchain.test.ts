import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { YAML } from 'bun';

const repoRoot = join(import.meta.dir, '..', '..');
const actionDir = join(repoRoot, '.github/actions/install-toolchain');

interface Step {
  id?: string;
  if?: string;
  uses?: string;
  'continue-on-error'?: boolean;
  with?: Record<string, unknown>;
}

// setup-toolchain downloads the proto binary from GitHub Releases on every run,
// before its own cache restore; a 503 there killed every job before a test ran.
describe('the toolchain install survives a release-download outage', () => {
  test('no workflow step calls setup-toolchain directly', () => {
    const workflow = YAML.parse(readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf-8')) as {
      jobs: Record<string, { steps?: Step[] }>;
    };
    const direct = Object.entries(workflow.jobs).flatMap(([job, { steps = [] }]) =>
      steps.filter((s) => s.uses?.startsWith('moonrepo/setup-toolchain@')).map(() => job)
    );
    expect(direct).toEqual([]);
  });

  test('a cache hit skips every install attempt, and a miss gets five with only the last fatal', () => {
    const action = YAML.parse(readFileSync(join(actionDir, 'action.yml'), 'utf-8')) as { runs: { steps: Step[] } };
    const installs = action.runs.steps.filter((s) => s.uses?.startsWith('moonrepo/setup-toolchain@'));
    expect(installs).toHaveLength(5);
    for (const step of installs) expect(step.if).toContain("steps.cached.outputs.ok != 'true'");
    expect(installs.slice(0, 4).every((s) => s['continue-on-error'] === true)).toBe(true);
    expect(installs[4]['continue-on-error']).toBeUndefined();
  });
});

describe('a cached toolchain is used only at its pinned versions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentkit-toolchain-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const pins = join(dir, '.prototools');
  writeFileSync(pins, 'bun = "1.3.4"\nmoon = "2.4.5"\n\n[settings]\nauto-install = true\n');
  const fake = (tool: string, answer: string) => {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho '${answer}'\n`);
    chmodSync(join(bin, tool), 0o755);
  };
  const check = () =>
    Bun.spawnSync([join(actionDir, 'cached-ok.sh'), pins], {
      env: { PATH: `${bin}:/usr/bin:/bin` },
      stdout: 'pipe',
    });

  test('every pinned tool answering its version passes, and sections after the pins are ignored', () => {
    fake('bun', '1.3.4');
    fake('moon', 'moon 2.4.5');
    expect(check().exitCode).toBe(0);
  });

  test('one tool at another version fails', () => {
    fake('bun', '1.3.4');
    fake('moon', 'moon 2.4.4');
    const run = check();
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString()).toContain("cached moon answered 'moon 2.4.4', expected 2.4.5");
  });

  test('a tool missing from the cache fails', () => {
    rmSync(join(bin, 'moon'));
    fake('bun', '1.3.4');
    expect(check().exitCode).toBe(1);
  });
});

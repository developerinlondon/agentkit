import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { YAML } from 'bun';

const repoRoot = join(import.meta.dir, '..', '..');

interface WorkflowStep {
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs: Record<string, WorkflowJob>;
}

// setup-go's default cache key looks for go.mod at the repo root; a job whose
// go.mod lives at docs/hextra/go.mod never primes the cache without this, so
// every restore is a cold one.
describe('the docs jobs prime the setup-go cache', () => {
  test('every setup-go step scoped to docs/hextra/go.mod also caches it', () => {
    const workflow = YAML.parse(
      readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf-8'),
    ) as Workflow;

    const offenders: string[] = [];
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (!step.uses?.startsWith('actions/setup-go@')) continue;
        if (step.with?.['go-version-file'] !== 'docs/hextra/go.mod') continue;
        if (step.with?.['cache-dependency-path'] !== 'docs/hextra/go.mod') offenders.push(jobName);
      }
    }
    expect(offenders).toEqual([]);
  });
});

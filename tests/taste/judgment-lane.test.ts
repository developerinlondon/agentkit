import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateCommand } from '../../skills/taste/scripts/police.ts';
import {
  type Budget,
  BUDGET_SPENT,
  JUDGMENT_BUDGET_MS,
  JUDGMENT_CALL_MS,
  JUDGMENT_FLOOR_MS,
  judgmentBudget,
} from '../../skills/taste/scripts/rules/budget.ts';
import {
  cleanUp,
  evaluate,
  POLICY,
  provider,
  QUESTION,
  recordingGit,
  repo,
  scratch,
} from './judgment-fixtures.ts';

afterEach(cleanUp);

// A taste folder the lint accepts, so the whole hook lane runs over it rather
// than the kind alone. Names decide the order tastes are evaluated in, which is
// what lets a later taste prove it still enforces after an earlier one stalled.
function blockingTaste(name: string, rule: Record<string, string>): string {
  const lines = [
    `name: ${name}`,
    'scope: project',
    'strength: require',
    'enforce: block',
    'provenance: 2026-09-21 · session correction',
    'rule:',
    ...Object.entries(rule).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`),
  ];
  return `---\n${lines.join('\n')}\n---\n\n${POLICY}\n`;
}

function project(tastes: Record<string, Record<string, string>>): string {
  const dir = repo();
  mkdirSync(join(dir, '.agentkit', 'tastes'), { recursive: true });
  for (const [name, rule] of Object.entries(tastes)) {
    writeFileSync(join(dir, '.agentkit', 'tastes', `${name}.md`), blockingTaste(name, rule));
  }
  return dir;
}

const JUDGE = (name: string) => ({
  kind: 'judgment',
  question: QUESTION,
  remedy: `Fix the cause (${name}).`,
  override: 'AGENTKIT_ALLOW_STOPGAP',
});

describe('one budget for every judgment in a command', () => {
  // The hook runs the evaluator under a process cap and reads nothing when it
  // is killed, so every blocking taste goes unenforced. The budget has to bound
  // the whole run, not each call.
  test('two stalled judgments still leave a command taste enforcing', async () => {
    const stub = provider({ hang: true });
    const cwd = project({
      'aa-stalls': JUDGE('aa'),
      'ab-stalls': JUDGE('ab'),
      'zz-tag-tier': {
        kind: 'command',
        match: 'git commit',
        remedy: 'Say what the commit does.',
        override: 'AGENTKIT_TAG_TIER',
      },
    });
    const started = Date.now();
    const verdict = await evaluateCommand({
      command: 'git commit -m "paper over it"',
      cwd,
      home: scratch(),
      env: { PATH: process.env.PATH, TYPESAFE_API_KEY: 'sk-test', TYPESAFE_BASE_URL: stub.url },
    });
    const elapsed = Date.now() - started;

    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('Say what the commit does.');
    expect(verdict.notices.filter((notice) => notice.includes('UNCHECKED'))).toHaveLength(2);
    expect(elapsed).toBeLessThan(JUDGMENT_BUDGET_MS + 2500);
  }, 20000);

  // The aggregate budget clamps every grant, so a per-call cap above it would
  // change nothing and go unnoticed. One stalled taste pins it.
  test('one stalled judgment gives up at the per-call cap, not at the budget', async () => {
    const stub = provider({ hang: true });
    const cwd = project({ 'aa-stalls': JUDGE('aa') });
    const started = Date.now();
    const verdict = await evaluateCommand({
      command: 'git commit -m "paper over it"',
      cwd,
      home: scratch(),
      env: { PATH: process.env.PATH, TYPESAFE_API_KEY: 'sk-test', TYPESAFE_BASE_URL: stub.url },
    });
    const elapsed = Date.now() - started;

    expect(JUDGMENT_CALL_MS).toBeLessThan(JUDGMENT_BUDGET_MS);
    expect(verdict.notices.join(' ')).toContain(`timeout after ${JUDGMENT_CALL_MS}ms`);
    expect(elapsed).toBeLessThan(JUDGMENT_CALL_MS + 1200);
  }, 20000);

  test('a judgment reached after the budget is spent says so', async () => {
    const stub = provider({ hang: true });
    const cwd = project({
      'aa-stalls': JUDGE('aa'),
      'ab-stalls': JUDGE('ab'),
      'ac-stalls': JUDGE('ac'),
    });
    const verdict = await evaluateCommand({
      command: 'git commit -m "paper over it"',
      cwd,
      home: scratch(),
      env: { PATH: process.env.PATH, TYPESAFE_API_KEY: 'sk-test', TYPESAFE_BASE_URL: stub.url },
    });

    expect(verdict.decision).toBe('allow');
    expect(verdict.notices.join(' ')).toContain('judgment budget for this command is spent');
    expect(verdict.notices.join(' ')).not.toContain('git could not be run');
    expect(stub.sent.length).toBeLessThan(3);
  }, 20000);
});

// A budget with exactly this much left, so where the run stands against the
// floor is set by the test rather than by how long the steps before it took.
function budgetLeaving(ms: number): Budget {
  const budget = judgmentBudget();
  budget.spend(JUDGMENT_BUDGET_MS - ms);
  return budget;
}

// A git that never answers, so the only thing that ends it is the deadline.
function stallingGit(): string {
  const dir = scratch();
  writeFileSync(join(dir, 'git'), '#!/bin/sh\nexec sleep 30\n');
  chmodSync(join(dir, 'git'), 0o755);
  return dir;
}

describe('a budget too short to finish a step is reported as spent', () => {
  // Started with a few milliseconds left, git is killed before it can answer
  // and the user is told git failed, when what ran out was the budget.
  test('under the floor, nothing is started and the budget is named', async () => {
    const git = recordingGit();
    const stub = provider({ noul: 0.99 });
    const outcome = await evaluate({}, {
      url: stub.url,
      env: { PATH: `${git.dir}:${process.env.PATH}` },
      budget: budgetLeaving(JUDGMENT_FLOOR_MS - 1),
    });

    expect(outcome).toEqual({ verdict: 'unchecked', detail: BUDGET_SPENT });
    expect(git.asked()).toBe(false);
    expect(stub.sent).toHaveLength(0);
  });

  test('with room above the floor, the judgment still runs', async () => {
    const stub = provider({ noul: 0.99 });
    const outcome = await evaluate({}, {
      url: stub.url,
      budget: budgetLeaving(JUDGMENT_FLOOR_MS + 1500),
    });

    expect(outcome.verdict).toBe('fires');
  });

  test('a git cut off by the budget, not its own cap, says the budget ran out', async () => {
    const started = Date.now();
    const outcome = await evaluate({}, {
      env: { PATH: `${stallingGit()}:${process.env.PATH}` },
      budget: budgetLeaving(JUDGMENT_FLOOR_MS + 200),
    });

    expect(outcome).toEqual({ verdict: 'unchecked', detail: BUDGET_SPENT });
    expect(Date.now() - started).toBeLessThan(JUDGMENT_FLOOR_MS + 2000);
  }, 10000);

  // The other side of the line: with the whole budget left, a git that stalls
  // hits its own cap, and that is git failing, not the budget running out.
  test('a git that outlives its own cap is still a git failure', async () => {
    const outcome = await evaluate({}, { env: { PATH: `${stallingGit()}:${process.env.PATH}` } });

    expect(outcome.verdict).toBe('unchecked');
    expect(outcome.verdict === 'unchecked' ? outcome.detail : '').toContain('git could not be run');
  }, 10000);

  // Margins here are wide on purpose: the real git diff before the provider
  // spends from the same budget, and a slow runner must not push it under the
  // floor before the provider is reached. 2500ms left is still under the cap.
  test('a provider call cut off by the budget says the budget ran out', async () => {
    const stub = provider({ hang: true });
    const outcome = await evaluate({}, {
      url: stub.url,
      budget: budgetLeaving(JUDGMENT_FLOOR_MS + 1500),
    });

    expect(outcome).toEqual({ verdict: 'unchecked', detail: BUDGET_SPENT });
    expect(stub.sent).toHaveLength(1);
  }, 10000);

  test('an override the budget then shortens is cut off by the budget', async () => {
    const stub = provider({ hang: true });
    const outcome = await evaluate({}, {
      url: stub.url,
      env: { TYPESAFE_TIMEOUT_MS: '3500' },
      budget: budgetLeaving(JUDGMENT_FLOOR_MS + 1500),
    });

    expect(outcome).toEqual({ verdict: 'unchecked', detail: BUDGET_SPENT });
  }, 10000);

  // Only running out of time is the budget's doing. A provider that refuses
  // inside a shortened deadline still refused.
  test('a provider error inside a shortened deadline still names the provider', async () => {
    const stub = provider({ status: 500 });
    const outcome = await evaluate({}, {
      url: stub.url,
      budget: budgetLeaving(JUDGMENT_FLOOR_MS + 1500),
    });

    expect(outcome.verdict).toBe('unchecked');
    expect(outcome.verdict === 'unchecked' ? outcome.detail : '').toContain('HTTP 500');
  });

  // Finding the branch to compare against is git too. A budget that ran out
  // there is not a repository with no default branch.
  test('a merge request under the floor names the budget, not a missing branch', async () => {
    const git = recordingGit();
    const outcome = await evaluate({ on: 'merge-request' }, {
      command: 'gh pr create --fill',
      env: { PATH: `${git.dir}:${process.env.PATH}` },
      budget: budgetLeaving(JUDGMENT_FLOOR_MS - 1),
    });

    expect(outcome).toEqual({ verdict: 'unchecked', detail: BUDGET_SPENT });
    expect(git.asked()).toBe(false);
  });

  test('a merge request whose branch lookup the budget cut off names the budget', async () => {
    const outcome = await evaluate({ on: 'merge-request' }, {
      command: 'gh pr create --fill',
      env: { PATH: `${stallingGit()}:${process.env.PATH}` },
      budget: budgetLeaving(JUDGMENT_FLOOR_MS + 200),
    });

    expect(outcome).toEqual({ verdict: 'unchecked', detail: BUDGET_SPENT });
  }, 10000);
});

describe('a deliberate override is read before the check it overrules', () => {
  test('an override set on the command sends nothing to the provider', async () => {
    const stub = provider({ noul: 0.99 });
    const cwd = project({ 'aa-stalls': JUDGE('aa') });
    const verdict = await evaluateCommand({
      command: 'AGENTKIT_ALLOW_STOPGAP=1 git commit -m "paper over it"',
      cwd,
      home: scratch(),
      env: { PATH: process.env.PATH, TYPESAFE_API_KEY: 'sk-test', TYPESAFE_BASE_URL: stub.url },
    });

    expect(verdict.decision).toBe('allow');
    expect(verdict.notices.join(' ')).toContain('set deliberately');
    expect(stub.sent).toHaveLength(0);
  });

  test('an override exported into the session does the same', async () => {
    const stub = provider({ noul: 0.99 });
    const cwd = project({ 'aa-stalls': JUDGE('aa') });
    const verdict = await evaluateCommand({
      command: 'git commit -m "paper over it"',
      cwd,
      home: scratch(),
      env: {
        PATH: process.env.PATH,
        TYPESAFE_API_KEY: 'sk-test',
        TYPESAFE_BASE_URL: stub.url,
        AGENTKIT_ALLOW_STOPGAP: '1',
      },
    });

    expect(verdict.decision).toBe('allow');
    expect(stub.sent).toHaveLength(0);
  });

  // The short-circuit must not turn an exported override into a notice on
  // every command the session runs.
  test('an exported override says nothing about a command the rule never judges', async () => {
    const stub = provider({ noul: 0.99 });
    const cwd = project({ 'aa-stalls': JUDGE('aa') });
    const verdict = await evaluateCommand({
      command: 'git status --short',
      cwd,
      home: scratch(),
      env: {
        PATH: process.env.PATH,
        TYPESAFE_API_KEY: 'sk-test',
        TYPESAFE_BASE_URL: stub.url,
        AGENTKIT_ALLOW_STOPGAP: '1',
      },
    });

    expect(verdict.decision).toBe('allow');
    expect(verdict.notices).toEqual([]);
    expect(stub.sent).toHaveLength(0);
  });

  test('the refusal says which part of the command went unchecked', async () => {
    const stub = provider({ noul: 0.9 });
    const cwd = project({ 'aa-stalls': JUDGE('aa') });
    const verdict = await evaluateCommand({
      command: 'git commit -m "slop" && cd "$T" && git commit -m "later"',
      cwd,
      home: scratch(),
      env: { PATH: process.env.PATH, TYPESAFE_API_KEY: 'sk-test', TYPESAFE_BASE_URL: stub.url },
    });

    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('changes directory');
    expect(verdict.notices.join(' ')).toContain('changes directory');
  });

  test('an override that does not read as deliberate still pays for the check', async () => {
    const stub = provider({ noul: 0.99 });
    const cwd = project({ 'aa-stalls': JUDGE('aa') });
    const verdict = await evaluateCommand({
      command: 'AGENTKIT_ALLOW_STOPGAP=0 git commit -m "paper over it"',
      cwd,
      home: scratch(),
      env: { PATH: process.env.PATH, TYPESAFE_API_KEY: 'sk-test', TYPESAFE_BASE_URL: stub.url },
    });

    expect(verdict.decision).toBe('deny');
    expect(stub.sent).toHaveLength(1);
  });
});

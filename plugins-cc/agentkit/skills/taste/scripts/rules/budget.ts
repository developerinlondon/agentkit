// One allowance for every judgment in a single command, because the hook that
// runs the evaluator caps the whole process: a per-call deadline bounds one
// taste while three of them together still reach the cap, and a killed
// evaluator writes nothing, so every other blocking taste goes unenforced too.
// Bounding the run rather than the call is what keeps that from happening.
export const JUDGMENT_BUDGET_MS = 5000;
export const JUDGMENT_CALL_MS = 4000;
// Below this, a step would be started only to be killed by the budget, and the
// kill would read as git or the provider failing rather than as time running out.
export const JUDGMENT_FLOOR_MS = 1000;

export interface Budget {
  // What the next step may take: never more than it asks for, never more than
  // is left, and nothing at all once what is left is under the floor.
  grant(maxMs: number): number;
  spend(ms: number): void;
}

export function judgmentBudget(totalMs: number = JUDGMENT_BUDGET_MS): Budget {
  let left = totalMs;
  return {
    grant: (maxMs: number) => left < JUDGMENT_FLOOR_MS ? 0 : Math.min(left, maxMs),
    spend: (ms: number) => {
      left = Math.max(0, left - ms);
    },
  };
}

// A grant a few milliseconds under the cap is timer jitter, not the budget
// cutting the step short; a timeout there is still the step's own.
export const BUDGET_SLACK_MS = 100;

export function shortenedByBudget(grantedMs: number, capMs: number): boolean {
  return capMs - grantedMs >= BUDGET_SLACK_MS;
}

export const BUDGET_SPENT = `the ${JUDGMENT_BUDGET_MS}ms judgment budget for this command is `
  + 'spent — the judgments in this command used it, and one command may not hold the hook for '
  + 'longer';

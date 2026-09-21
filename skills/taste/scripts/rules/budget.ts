// One allowance for every judgment in a single command, because the hook that
// runs the evaluator caps the whole process: a per-call deadline bounds one
// taste while three of them together still reach the cap, and a killed
// evaluator writes nothing, so every other blocking taste goes unenforced too.
// Bounding the run rather than the call is what keeps that from happening.
export const JUDGMENT_BUDGET_MS = 5000;
export const JUDGMENT_CALL_MS = 4000;

export interface Budget {
  // What the next step may take: never more than it asks for, never more than
  // is left.
  grant(maxMs: number): number;
  spend(ms: number): void;
  spent(): boolean;
}

export function judgmentBudget(totalMs: number = JUDGMENT_BUDGET_MS): Budget {
  let left = totalMs;
  return {
    grant: (maxMs: number) => Math.max(0, Math.min(left, maxMs)),
    spend: (ms: number) => {
      left = Math.max(0, left - ms);
    },
    spent: () => left <= 0,
  };
}

export const BUDGET_SPENT = `the ${JUDGMENT_BUDGET_MS}ms judgment budget for this command is `
  + 'spent — an earlier judgment taste used it, and one command may not hold the hook for longer';

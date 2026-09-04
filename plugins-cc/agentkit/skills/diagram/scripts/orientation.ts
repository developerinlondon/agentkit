// Choosing an orientation for an author who set none: the rule both renderers
// rank their candidates with, and the probe that reads whether a d2 source
// already made the choice itself.

// The page gives a figure a column about 977 px wide and caps its height at
// 60vh, roughly 540 px on a 900 px viewport.
const COLUMN_WIDTH = 977;
const READING_HEIGHT = 540;
const TARGET_ASPECT = COLUMN_WIDTH / READING_HEIGHT;

export type Direction = "right" | "down";

export const DIRECTIONS: Direction[] = ["right", "down"];

export interface Sized {
  direction: Direction;
  width: number;
  height: number;
}

/** What the page displays the figure at: it fits the figure inside the window
 * on both axes and never enlarges it, so this is also what happens to the
 * type. Bigger is better, and a figure that already fits scores 1. */
export function displayScale(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return 0;
  return Math.min(1, COLUMN_WIDTH / width, READING_HEIGHT / height);
}

function aspectDistance(width: number, height: number): number {
  return Math.abs(Math.log(width / height / TARGET_ASPECT));
}

/** Larger type on the page wins. Between two candidates the window already
 * holds whole, nothing is shrunk and there is no type to compare, so the one
 * shaped more like the window wins instead. A tie keeps the first. */
export function betterFit<T extends Sized>(a: T, b: T): { kept: T; dropped: T } {
  const scaleA = displayScale(a.width, a.height);
  const scaleB = displayScale(b.width, b.height);
  const bWins = scaleA >= 1 && scaleB >= 1
    ? aspectDistance(b.width, b.height) < aspectDistance(a.width, a.height)
    : scaleB > scaleA;
  return bWins ? { kept: b, dropped: a } : { kept: a, dropped: b };
}

function dims(s: Sized): string {
  return `${Math.round(s.width)}x${Math.round(s.height)}`;
}

export function orientationEvidence(kept: Sized, dropped: Sized): string {
  return `orientation: ${kept.direction} (${dims(kept)}) beat ${dropped.direction} (${dims(dropped)})`;
}

/** A `direction` on the board itself is the author's own choice and is never
 * displaced. Statements end at a newline or a semicolon, since d2 takes the
 * last of two board directions and an appended one would silently win over
 * `a -> b; direction: down`. Braces and comment marks are read outside quotes
 * only: a label carrying `{` or `#` is text, not structure. */
export function declaresDirection(source: string): boolean {
  let depth = 0;
  let quote = "";
  let comment = false;
  let statement = "";
  const ends = (): boolean => {
    const board = depth === 0 && /^\s*direction\s*:/.test(statement);
    statement = "";
    return board;
  };
  for (const ch of source) {
    if (comment) {
      if (ch !== "\n") continue;
      comment = false;
      if (ends()) return true;
    } else if (quote) {
      if (ch === quote) quote = "";
      statement += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      statement += ch;
    } else if (ch === "#") {
      comment = true;
    } else if (ch === "\n" || ch === ";") {
      if (ends()) return true;
    } else if (ch === "{") {
      if (ends()) return true;
      depth += 1;
    } else if (ch === "}") {
      statement = "";
      depth = Math.max(0, depth - 1);
    } else {
      statement += ch;
    }
  }
  return ends();
}

/** Appended rather than prefixed: a line added at the top shifts every line
 * number in d2's compile errors, and a board keyword reads the same at either
 * end of the file. */
export function withDirection(source: string, direction: Direction): string {
  return `${source.replace(/\n*$/, "")}\ndirection: ${direction}\n`;
}

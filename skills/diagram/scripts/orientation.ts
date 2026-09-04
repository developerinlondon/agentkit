// Choosing an orientation for an author who set none: the score both renderers
// rank their candidates with, and the probe that reads whether a d2 source
// already made the choice itself.

// The page column renders a figure about 977 px wide into roughly 540 px of
// reading height (60vh of a 900 px viewport), so a figure near 1.8:1 arrives
// legible without zooming or scrolling.
export const COLUMN_WIDTH = 977;
export const READING_HEIGHT = 540;
export const TARGET_ASPECT = COLUMN_WIDTH / READING_HEIGHT;

export type Direction = "right" | "down";

export const DIRECTIONS: Direction[] = ["right", "down"];

export interface Sized {
  direction: Direction;
  width: number;
  height: number;
}

/** Two costs, both in log space so they add. The first is distance from the
 * reading window's proportion, where a figure twice as wide as the target
 * loses exactly as much as one half as wide. The second is what the page
 * charges for a figure wider than the column: it scales the whole thing down
 * to fit and the type shrinks with it, while a figure taller than the window
 * only scrolls. Vertical space is free and horizontal space is not, so a
 * strip that has to shrink loses to a column that does not. */
export function fitScore(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return Infinity;
  return Math.abs(Math.log(width / height / TARGET_ASPECT)) + Math.max(0, Math.log(width / COLUMN_WIDTH));
}

export function betterFit<T extends Sized>(a: T, b: T): { kept: T; dropped: T } {
  return fitScore(b.width, b.height) < fitScore(a.width, a.height)
    ? { kept: b, dropped: a }
    : { kept: a, dropped: b };
}

function dims(s: Sized): string {
  return `${Math.round(s.width)}x${Math.round(s.height)}`;
}

export function orientationEvidence(kept: Sized, dropped: Sized): string {
  return `orientation: ${kept.direction} (${dims(kept)}) beat ${dropped.direction} (${dims(dropped)})`;
}

/** A `direction` on the board itself is the author's own choice and is never
 * displaced. Brace depth is tracked because `x: { direction: down }` turns a
 * container, not the board, and quotes are tracked because a `"#f00"` fill
 * would otherwise read as a comment and swallow the rest of the line. */
export function declaresDirection(source: string): boolean {
  let depth = 0;
  for (const line of source.split("\n")) {
    const code = stripComment(line);
    if (depth === 0 && /^\s*direction\s*:/.test(code)) return true;
    for (const ch of code) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth = Math.max(0, depth - 1);
    }
  }
  return false;
}

function stripComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

/** Appended rather than prefixed: a line added at the top shifts every line
 * number in d2's compile errors, and a board keyword reads the same at either
 * end of the file. */
export function withDirection(source: string, direction: Direction): string {
  return `${source.replace(/\n*$/, "")}\ndirection: ${direction}\n`;
}

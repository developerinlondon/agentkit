import { readFileSync } from "node:fs";
import { join } from "node:path";

export const UNIT = 100;
export const METRICS_PATH = join(import.meta.dir, "../../assets/font-metrics.json");

const ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");
const LATIN1 = Array.from({ length: 96 }, (_, i) => String.fromCharCode(0xa0 + i)).join("");
const SYMBOLS = "→←↔⇒⇐⇔∪∩⊂⊆∈≠≤≥×·•…—–✓✗▲▼◀▶°±§¶©®™†‡‹›«»“”‘’€£¥";
/** Candidates offered to the generator; only glyphs the font carries are kept. */
export const CHARSET = ASCII + LATIN1 + SYMBOLS;

interface MetricsFile {
  unit: number;
  families: Record<string, Record<string, number>>;
}

let cache: MetricsFile | undefined;

function metrics(): MetricsFile {
  if (!cache) {
    try {
      cache = JSON.parse(readFileSync(METRICS_PATH, "utf8")) as MetricsFile;
    } catch (e) {
      throw new Error(
        `cannot read font metrics (${(e as Error).message}) — regenerate with: bun scripts/layout/font-metrics.ts`,
      );
    }
  }
  return cache;
}

/** Families that carry this glyph. Empty means no font in the output has it. */
export function carriedBy(ch: string): number[] {
  const m = metrics();
  return Object.entries(m.families).filter(([, t]) => typeof t[ch] === "number").map(([f]) => Number(f));
}

/** Advance-width sum of one line, in px, for an Excalidraw fontFamily id. */
export function lineWidth(line: string, fontFamily: number, fontSize: number): number {
  const m = metrics();
  const table = m.families[String(fontFamily)];
  if (!table) throw new Error(`no font metrics for fontFamily ${fontFamily}`);
  let total = 0;
  for (const ch of line) {
    const w = table[ch];
    if (w === undefined) throw new Error(`"${ch}" is not in the font metrics table for fontFamily ${fontFamily}`);
    total += w;
  }
  return (total / m.unit) * fontSize;
}

export function textWidth(text: string, fontFamily: number, fontSize: number): number {
  return Math.max(...text.split("\n").map((l) => lineWidth(l, fontFamily, fontSize)));
}

/** Excalidraw's own text box height: lineHeight 1.25 per line. */
export function textHeight(text: string, fontSize: number): number {
  return text.split("\n").length * fontSize * 1.25;
}

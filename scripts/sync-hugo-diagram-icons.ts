#!/usr/bin/env bun
// Writes the vendored CC0 icon packs into the Hugo diagrams module as data
// files, so a Hugo site and a D2 render draw the same marks from one source.
// Usage: bun scripts/sync-hugo-diagram-icons.ts [--check]   (--check exits 1 when the files are stale)

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assetsDir, monochromeFills } from "../skills/diagram/scripts/icons.ts";

const outDir = join(import.meta.dir, "..", "hugo", "diagrams", "data", "diagram_icons");
const PACKS = ["logos", "simple-icons"];

interface HugoIcon {
  view: string;
  mode: "mono" | "color";
  body: string;
}

function pack(set: string): Record<string, HugoIcon> {
  const mono = monochromeFills();
  const selection = JSON.parse(readFileSync(join(assetsDir, "icon-selection.json"), "utf8"));
  const isMono = !!selection.packs?.[set]?.monochromeFill;
  const icons: Record<string, HugoIcon> = {};
  for (const file of readdirSync(join(assetsDir, set)).filter((f) => f.endsWith(".svg")).sort()) {
    const svg = readFileSync(join(assetsDir, set, file), "utf8");
    const view = svg.match(/viewBox="([^"]+)"/)?.[1];
    const body = svg.match(/^<svg[^>]*>([\s\S]*)<\/svg>\s*$/)?.[1];
    if (!view || body === undefined) throw new Error(`${set}/${file}: not a single <svg> element with a viewBox`);
    if (/<svg[\s>]/.test(body)) throw new Error(`${set}/${file}: nested <svg> breaks Hugo's minifier`);
    // Monochrome marks follow the page ink; full-colour brand artwork is never recoloured.
    const inked = isMono ? mono.reduce((b, fill) => b.split(`"${fill}"`).join('"currentColor"'), body) : body;
    icons[file.slice(0, -4)] = { view, mode: isMono ? "mono" : "color", body: inked };
  }
  return icons;
}

let stale = false;
for (const set of PACKS) {
  const path = join(outDir, `${set}.json`);
  const next = `${JSON.stringify(pack(set), null, 2)}\n`;
  let current = "";
  try {
    current = readFileSync(path, "utf8");
  } catch {}
  if (current === next) continue;
  if (process.argv.includes("--check")) {
    console.error(`hugo-icons: ${path} is stale; run bun scripts/sync-hugo-diagram-icons.ts`);
    stale = true;
  } else {
    writeFileSync(path, next);
    console.log(`hugo-icons: wrote ${path}`);
  }
}
process.exit(stale ? 1 : 0);

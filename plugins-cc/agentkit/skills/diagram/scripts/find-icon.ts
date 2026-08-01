#!/usr/bin/env bun
// Searches the vendored icon manifest so a name never has to be guessed.

import { existsSync } from "node:fs";
import { searchIcons } from "./icons.ts";
import { packDir, packs } from "./vendor-packs.ts";

const term = process.argv.slice(2).filter((a: string) => !a.startsWith("--")).join(" ");
const hits = searchIcons(term);

if (hits.length === 0) {
  console.log(`no vendored icon matches "${term}".`);
  const fetched = Object.keys(packs()).filter((p) => existsSync(packDir(p)));
  console.log(
    fetched.length > 0
      ? `fetched vendor packs available: ${fetched.join(", ")} — reference as @<pack>:<name>`
      : "no vendor packs fetched; see references/VENDOR-LICENSES.md for azure/gcp",
  );
  console.log("if the mark is genuinely absent, say so rather than substituting a look-alike.");
  process.exit(1);
}

const width = Math.max(...hits.map((h) => h.key.length));
for (const h of hits) {
  const kind = h.monochrome ? "monochrome (theme-inked automatically)" : "full-colour brand artwork";
  console.log(`@${h.key.padEnd(width)}  ${h.set.padEnd(13)} ${h.license.padEnd(8)} ${kind}`);
}
console.log(`\n${hits.length} match(es). Monochrome marks need no plate — never set style.fill to make one legible.`);

#!/usr/bin/env bun
// Regenerates assets/iconify/ from upstream packs; output is committed.
// Usage and how to fetch the packs: references/technical-register.md.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const assetsDir = join(import.meta.dir, "..", "assets", "iconify");

function fail(msg: string): never {
  console.error(`trim-iconify: ${msg}`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

interface IconEntry {
  body: string;
  width?: number;
  height?: number;
  left?: number;
  top?: number;
}
interface IconSet {
  prefix: string;
  width?: number;
  height?: number;
  icons: Record<string, IconEntry>;
}
interface PackInfo {
  name: string;
  author: { name: string; url?: string };
  license: { title: string; spdx: string; url?: string };
  total?: number;
  version?: string;
}
interface PackSelection {
  npm: string;
  version: string;
  monochromeFill?: string;
  icons: string[];
}
interface Selection {
  packs: Record<string, PackSelection>;
  aliases: Record<string, string>;
}

const packsRoot = arg("packs") ?? fail("--packs <dir> is required");

// The extracted tarball directory name carries the version, so the pin is
// checked against the tree actually being read rather than a passed-in string.
function findPackage(prefix: string, version: string): string {
  const wanted = `iconify-json-${prefix}-${version}`;
  const entries = readdirSync(packsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const exact = entries.find((e) => e === wanted);
  if (!exact) {
    const near = entries.filter((e) => e.startsWith(`iconify-json-${prefix}-`));
    fail(
      `pinned pack ${wanted} not found under ${packsRoot}`
        + (near.length ? ` — found ${near.join(", ")} instead; update icon-selection.json or fetch the pinned version` : ""),
    );
  }
  return join(packsRoot, exact, "package");
}

function svgFor(name: string, icon: IconEntry, set: IconSet, monochromeFill?: string): string {
  const w = icon.width ?? set.width ?? fail(`${name}: no width and pack has no default`);
  const h = icon.height ?? set.height ?? fail(`${name}: no height and pack has no default`);
  const box = `${icon.left ?? 0} ${icon.top ?? 0} ${w} ${h}`;
  let body = icon.body;
  if (monochromeFill) {
    // Inside a d2 <image> the icon is its own document, where currentColor
    // resolves to black — invisible on a dark island. The substitute is fixed,
    // never theme-derived: a themed vendor mark breaches the trademark rule.
    if (!body.includes("currentColor")) fail(`${name}: expected currentColor in a monochrome pack`);
    body = body.replaceAll("currentColor", monochromeFill);
  } else if (body.includes("currentColor")) {
    fail(`${name}: full-colour pack yielded a currentColor body — it would render invisible`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" width="${w}" height="${h}">${body}</svg>\n`;
}

function notice(prefix: string, sel: PackSelection, info: PackInfo): string {
  return [
    `${info.name} (Iconify set "${prefix}")`,
    ``,
    `Upstream:   ${sel.npm}@${sel.version}`,
    `Author:     ${info.author.name}${info.author.url ? ` <${info.author.url}>` : ""}`,
    `License:    ${info.license.title} (SPDX: ${info.license.spdx})`,
    info.license.url ? `License URL: ${info.license.url}` : "",
    ``,
    `Full licence text: ../LICENSE.CC0-1.0.txt`,
    ``,
    `This directory holds ${sel.icons.length} of ${info.total ?? "?"} icons from the set,`,
    `extracted verbatim by skills/diagram/scripts/trim-iconify.ts. Icon artwork is`,
    `NOT covered by this repository's own licence.`,
    ``,
    `Vendor logos are trademarks of their respective owners. They are reproduced`,
    `unmodified for nominative identification only, and must never be recoloured,`,
    `distorted, or theme-filtered.`,
    ``,
  ].filter((line) => line !== "").join("\n") + "\n";
}

const selection: Selection = JSON.parse(readFileSync(join(assetsDir, "icon-selection.json"), "utf8"));
const manifest: Record<string, { set: string; name: string; file: string; license: string }> = {};
const byteTotals: string[] = [];

for (const [prefix, sel] of Object.entries(selection.packs).sort(([a], [b]) => a.localeCompare(b))) {
  const pkgDir = findPackage(prefix, sel.version);
  const set: IconSet = JSON.parse(readFileSync(join(pkgDir, "icons.json"), "utf8"));
  const info: PackInfo = JSON.parse(readFileSync(join(pkgDir, "info.json"), "utf8"));
  if (set.prefix !== prefix) fail(`${pkgDir}: prefix is "${set.prefix}", expected "${prefix}"`);
  if (info.license.spdx !== "CC0-1.0") {
    fail(`${prefix}: licence is ${info.license.spdx}, only CC0-1.0 packs may be vendored`);
  }

  const outDir = join(assetsDir, prefix);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  let bytes = 0;
  for (const name of [...sel.icons].sort()) {
    const icon = set.icons[name];
    if (!icon) fail(`${prefix}: no icon "${name}" in ${sel.npm}@${sel.version}`);
    const svg = svgFor(name, icon, set, sel.monochromeFill);
    writeFileSync(join(outDir, `${name}.svg`), svg);
    bytes += Buffer.byteLength(svg);
    manifest[`${prefix}:${name}`] = {
      set: prefix,
      name,
      file: `${prefix}/${name}.svg`,
      license: info.license.spdx,
    };
  }
  writeFileSync(join(outDir, "NOTICE"), notice(prefix, sel, info));
  byteTotals.push(`${prefix}: ${sel.icons.length} icons, ${bytes} bytes`);
}

// Bare names are what an author reaches for. logos wins a cross-set collision:
// it carries the real brand colours, where simple-icons is a flat glyph.
for (const prefix of ["simple-icons", "logos"]) {
  for (const record of Object.values({ ...manifest })) {
    if (record.set === prefix) manifest[record.name] = record;
  }
}

for (const [alias, target] of Object.entries(selection.aliases)) {
  if (!manifest[target]) fail(`alias "${alias}" points at ${target}, which is not vendored`);
  manifest[alias] = manifest[target];
}

const ordered = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(join(assetsDir, "manifest.json"), JSON.stringify(ordered, null, 2) + "\n");

for (const line of byteTotals) console.log(line);
console.log(`manifest: ${Object.keys(ordered).length} lookup keys`);

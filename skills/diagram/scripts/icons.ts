// Resolves `icon: @key` references in .d2 source to vendored asset paths.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { IconError, type IconRecord, lookupVendorIcon, splitVendorKey } from "./vendor-packs.ts";

export { IconError, type IconRecord };

export const assetsDir = join(import.meta.dir, "..", "assets", "iconify");

let cached: Record<string, IconRecord> | undefined;

export function manifest(dir = assetsDir): Record<string, IconRecord> {
  if (dir === assetsDir && cached) return cached;
  const loaded = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  if (dir === assetsDir) cached = loaded;
  return loaded;
}

// The fill a monochrome pack was baked to. d2-svg re-inlines marks carrying it
// so the page theme can drive their ink; reading it from the selection keeps the
// two in step when a pack is re-vendored.
export function monochromeFills(dir = assetsDir): string[] {
  const sel = JSON.parse(readFileSync(join(dir, "icon-selection.json"), "utf8"));
  const packs = (sel.packs ?? {}) as Record<string, { monochromeFill?: string }>;
  return [...new Set(Object.values(packs).map((p) => p.monochromeFill).filter((f): f is string => !!f))];
}

export interface IconHit {
  key: string;
  set: string;
  monochrome: boolean;
  license: string;
}

// Icon names are only discoverable by reading the manifest, so a name that is
// absent reads the same as a name that was never vendored. Searching reports
// both, and whether a hit is brand artwork or a single-colour mark.
export function searchIcons(query: string, dir = assetsDir): IconHit[] {
  const m = manifest(dir);
  const mono = new Set(monochromeFillSets(dir));
  const q = query.trim().toLowerCase();
  return Object.entries(m)
    .filter(([key]) => key.includes(":") === false && (q === "" || key.includes(q)))
    .map(([key, r]) => ({ key, set: r.set, monochrome: mono.has(r.set), license: r.license }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function monochromeFillSets(dir = assetsDir): string[] {
  const sel = JSON.parse(readFileSync(join(dir, "icon-selection.json"), "utf8"));
  const packs = (sel.packs ?? {}) as Record<string, { monochromeFill?: string }>;
  return Object.entries(packs).filter(([, p]) => !!p.monochromeFill).map(([name]) => name);
}

function suggest(key: string, keys: string[]): string {
  const bare = key.split(":").pop() ?? key;
  const near = keys.filter((k) => {
    const kb = k.split(":").pop() ?? k;
    return k.includes(key) || kb.includes(bare) || bare.includes(kb);
  });
  const uniq = [...new Set(near)].slice(0, 5);
  return uniq.length
    ? ` — did you mean ${uniq.join(", ")}?`
    : " — no vendored icon matches; run `bun scripts/find-icon.ts <term>` to search";
}

export function lookupIcon(key: string, dir = assetsDir): { file: string; path: string } {
  const m = manifest(dir);
  const record = m[key];
  if (record) {
    const path = join(dir, record.file);
    if (!existsSync(path)) throw new IconError(`icon "${key}" maps to missing file ${record.file}`);
    return { file: record.file, path };
  }
  const vendor = splitVendorKey(key);
  if (vendor) return lookupVendorIcon(vendor.pack, vendor.name);
  throw new IconError(`unknown icon "${key}"${suggest(key, Object.keys(m))}`);
}

export function resolveIcon(key: string, dir = assetsDir): string {
  return lookupIcon(key, dir).path;
}

// `@key` keeps authored .d2 free of machine-specific paths; d2 only accepts a
// real path or URL, so the reference is expanded just before rendering.
const ICON_REF = /^(\s*icon\s*:\s*)@([A-Za-z0-9 ._:/-]+?)\s*$/gm;

export const STAGE_SUBDIR = "icons";

export interface StagedIcon {
  rel: string;
  src: string;
}

// d2 salts every generated element id from the source text it compiles, so an
// absolute path in that text makes the render depend on where the repo sits.
// The referenced icons are copied beside the staged source under their manifest
// path instead, leaving the hash a function of authored content alone.
export function expandIconRefs(
  source: string,
  dir = assetsDir,
): { source: string; count: number; staged: StagedIcon[] } {
  let count = 0;
  const staged = new Map<string, string>();
  const expanded = source.replace(ICON_REF, (_match, prefix: string, key: string) => {
    count += 1;
    const { file, path } = lookupIcon(key.trim(), dir);
    const rel = `${STAGE_SUBDIR}/${file}`;
    staged.set(rel, path);
    return `${prefix}${rel}`;
  });
  return { source: expanded, count, staged: [...staged].map(([rel, src]) => ({ rel, src })) };
}

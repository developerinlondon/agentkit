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

function suggest(key: string, keys: string[]): string {
  const near = keys.filter((k) => k.includes(key) || key.includes(k.split(":").pop() ?? k)).slice(0, 5);
  return near.length ? ` — did you mean ${near.join(", ")}?` : "";
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

// Resolves `icon: @key` references in .d2 source to vendored asset paths.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface IconRecord {
  set: string;
  name: string;
  file: string;
  license: string;
}

export const assetsDir = join(import.meta.dir, "..", "assets", "iconify");

let cached: Record<string, IconRecord> | undefined;

export function manifest(dir = assetsDir): Record<string, IconRecord> {
  if (dir === assetsDir && cached) return cached;
  const loaded = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  if (dir === assetsDir) cached = loaded;
  return loaded;
}

export class IconError extends Error {}

function suggest(key: string, keys: string[]): string {
  const near = keys.filter((k) => k.includes(key) || key.includes(k.split(":").pop() ?? k)).slice(0, 5);
  return near.length ? ` — did you mean ${near.join(", ")}?` : "";
}

export function resolveIcon(key: string, dir = assetsDir): string {
  const m = manifest(dir);
  const record = m[key];
  if (!record) throw new IconError(`unknown icon "${key}"${suggest(key, Object.keys(m))}`);
  const path = join(dir, record.file);
  if (!existsSync(path)) throw new IconError(`icon "${key}" maps to missing file ${record.file}`);
  return path;
}

// `@key` keeps authored .d2 free of machine-specific paths; d2 only accepts a
// real path or URL, so the reference is expanded just before rendering.
const ICON_REF = /^(\s*icon\s*:\s*)@([A-Za-z0-9 ._:-]+?)\s*$/gm;

export function expandIconRefs(source: string, dir = assetsDir): { source: string; count: number } {
  let count = 0;
  const expanded = source.replace(ICON_REF, (_match, prefix: string, key: string) => {
    count += 1;
    return `${prefix}${resolveIcon(key.trim(), dir)}`;
  });
  return { source: expanded, count };
}

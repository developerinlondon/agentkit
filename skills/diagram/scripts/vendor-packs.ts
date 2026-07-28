// Vendor icon packs are fetched, never vendored: their artwork is licensed by
// the vendor, not CC0, so the repository may hold only URLs, hashes and terms.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PackArchive {
  url: string;
  sha256: string;
  bytes?: number;
  label?: string;
}

export interface VendorPack {
  title: string;
  vendor: string;
  license: string;
  landingUrl: string;
  termsUrl: string;
  grant: "express" | "absent";
  terms: string[];
  archives: PackArchive[];
  nameFrom?: "dir" | "file";
  nameStrip?: string[];
  categorySkip?: string[];
  keepFiles?: string[];
}

export interface IconRecord {
  set: string;
  name: string;
  file: string;
  license: string;
}

export class IconError extends Error {}

const defaultRegistry = join(import.meta.dir, "..", "assets", "vendor-packs.json");

export function registryPath(): string {
  return process.env.AGENTKIT_DIAGRAM_VENDOR_PACKS ?? defaultRegistry;
}

export function packs(file = registryPath()): Record<string, VendorPack> {
  return JSON.parse(readFileSync(file, "utf8"));
}

// Outside the repository by default: a fetched tree is vendor-licensed, and an
// in-tree default is one `git add -A` away from committing it.
export function vendorRoot(): string {
  return process.env.AGENTKIT_DIAGRAM_VENDOR_ICONS ?? join(homedir(), ".agentkit", "diagram", "vendor-icons");
}

export function packDir(pack: string, root = vendorRoot()): string {
  return join(root, pack);
}

export const FETCH_SCRIPT = "skills/diagram/scripts/fetch-icons.ts";

export function fetchHint(pack: string): string {
  return `fetch it with: bun ${FETCH_SCRIPT} ${pack} --accept-terms`;
}

// A pack prefix may be written with either separator: `@azure:cosmos-db` matches
// the vendored `set:name` convention, `@azure/cosmos-db` is what a reader of the
// pack name reaches for first. Only the pack separator is normalised — anything
// after it keeps its slashes, which is how a category-qualified name is spelled.
export function splitVendorKey(key: string, file = registryPath()): { pack: string; name: string } | undefined {
  const at = key.search(/[:/]/);
  if (at < 0) return undefined;
  const pack = key.slice(0, at);
  if (!Object.hasOwn(packs(file), pack)) return undefined;
  return { pack, name: key.slice(at + 1) };
}

export function packManifest(pack: string, root = vendorRoot()): Record<string, IconRecord> | undefined {
  const path = join(packDir(pack, root), "manifest.json");
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

// A vendor name is usually got wrong by a word, not a letter — "cosmos-db" for
// "azure-cosmos-db". Shortening the stem a token at a time finds those, where a
// plain substring test on the whole string finds nothing.
function suggest(name: string, keys: string[]): string {
  const tokens = (name.split("/").pop() ?? name).split("-");
  for (let n = tokens.length; n > 0; n -= 1) {
    const probe = tokens.slice(0, n).join("-");
    const near = keys.filter((k) => k.includes(probe)).slice(0, 5);
    if (near.length > 0) return ` — did you mean ${near.join(", ")}?`;
  }
  return "";
}

// Resolution is separated from the "unknown icon" path on purpose: an absent
// pack is a fixable setup step, and reporting it as a bad name sends the reader
// hunting for a typo that is not there.
export function lookupVendorIcon(
  pack: string,
  name: string,
  root = vendorRoot(),
  file = registryPath(),
): { file: string; path: string } {
  const info = packs(file)[pack];
  if (!info) throw new IconError(`no vendor pack "${pack}" in ${registryPath()}`);
  const m = packManifest(pack, root);
  if (!m) {
    throw new IconError(
      `icon pack "${pack}" (${info.title}) is not installed, so @${pack}:${name} cannot resolve — ${fetchHint(pack)}`,
    );
  }
  const record = m[name];
  if (!record) {
    throw new IconError(
      `pack "${pack}" has no icon "${name}"${suggest(name, Object.keys(m))}`
        + ` — list what it does have with: bun ${FETCH_SCRIPT} ${pack} --list`,
    );
  }
  const path = join(packDir(pack, root), record.file);
  if (!existsSync(path)) {
    throw new IconError(
      `pack "${pack}" maps "${name}" to missing file ${record.file} — the fetched tree is damaged; re-run: bun ${FETCH_SCRIPT} ${pack} --accept-terms --force`,
    );
  }
  return { file: `${pack}/${record.file}`, path };
}

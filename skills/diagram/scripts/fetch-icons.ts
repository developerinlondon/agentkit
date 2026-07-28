#!/usr/bin/env bun
// Opt-in fetch of vendor-licensed icon packs into a local, uncommitted tree.
// Never run from a bare install: fetching is an acceptance of vendor terms the
// installing user has to make, so it is a deliberate per-pack invocation.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "./d2-svg.ts";
import {
  FETCH_SCRIPT,
  type IconRecord,
  type PackArchive,
  packDir,
  packs,
  registryPath,
  type VendorPack,
  vendorRoot,
} from "./vendor-packs.ts";

function fail(msg: string): never {
  console.error(`fetch-icons: ${msg}`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > 0 ? process.argv[i + 1] : undefined;
  if (v?.startsWith("--")) fail(`--${name} is missing its value`);
  return v;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function slugify(stem: string, strips: string[] = []): string {
  let s = stem;
  for (const pattern of strips) s = s.replace(new RegExp(pattern), "");
  // No camel-case splitting: vendor names are already space-, underscore- or
  // hyphen-separated, and splitting on case turns "IoT Hub" into "io-t-hub".
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function readArchive(url: string): Promise<Buffer> {
  if (url.startsWith("file:")) return readFileSync(fileURLToPath(url));
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    fail(
      `${url} returned HTTP ${res.status} ${res.statusText} — the vendor moved or withdrew the archive;`
        + ` check ${url.split("/").slice(0, 3).join("/")} and re-pin assets/vendor-packs.json`,
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// A vendor re-release changes the bytes under a URL we do not control. Accepting
// a changed archive silently would ship whatever the vendor swapped in — the
// pin exists precisely to make that a decision someone makes on purpose.
function verifyPin(archive: PackArchive, buf: Buffer): void {
  const found = sha256(buf);
  if (found === archive.sha256) return;
  fail(
    `checksum mismatch for ${archive.url}\n`
      + `  pinned:   ${archive.sha256}\n`
      + `  received: ${found} (${buf.length} bytes)\n`
      + `The vendor re-released this archive, or the download was tampered with. Nothing was installed.\n`
      + `To adopt the new release: verify the archive is genuinely the vendor's, re-read its terms at the\n`
      + `pack's termsUrl, then set sha256 to ${found} in skills/diagram/assets/vendor-packs.json.`,
  );
}

function unzipTo(buf: Buffer, dest: string): void {
  const zip = join(dest, "archive.zip");
  mkdirSync(dest, { recursive: true });
  writeFileSync(zip, buf);
  const out = join(dest, "tree");
  mkdirSync(out, { recursive: true });
  try {
    execFileSync("unzip", ["-q", "-o", zip, "-d", out], { stdio: "pipe" });
  } catch (e) {
    const err = e as { stderr?: Buffer; message: string };
    fail(`unzip failed: ${(err.stderr?.toString() ?? err.message).trim()}`);
  }
  rmSync(zip, { force: true });
}

function svgFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__MACOSX" || entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.endsWith(".svg")) found.push(abs);
    }
  };
  walk(root);
  // An archive entry that resolves outside the extraction root would write
  // wherever it liked; the pin makes that unlikely, not impossible.
  for (const f of found) {
    if (!resolve(f).startsWith(resolve(root) + sep)) fail(`archive entry escapes the extraction root: ${f}`);
  }
  return found.sort();
}

interface Candidate {
  abs: string;
  slug: string;
  qualifier: string;
  digest: string;
}

function candidateFor(abs: string, root: string, info: VendorPack, label: string): Candidate {
  const parts = relative(root, abs).split(sep);
  const stem = basename(abs, ".svg");
  const skip = new Set(info.categorySkip ?? []);
  const dirs = parts.slice(0, -1).filter((d) => !skip.has(d));
  const nameSource = info.nameFrom === "dir" ? (dirs.at(-1) ?? stem) : stem;
  const slug = slugify(nameSource, info.nameStrip);
  const qualifier = info.nameFrom === "dir" ? label : slugify(dirs.at(-1) ?? label);
  return { abs, slug, qualifier: qualifier || label, digest: sha256(readFileSync(abs)) };
}

interface Rejected {
  file: string;
  why: string;
}

// Vendor archives are not curated for embedding. An icon carrying active
// content or an external reference would travel into every rendered diagram, so
// it disqualifies the pack rather than being quietly dropped; a merely
// malformed icon is skipped and named.
function screen(abs: string): { ok: boolean; why?: string; fatal?: boolean } {
  const svg = readFileSync(abs, "utf8");
  if (!svg.includes("<svg")) return { ok: false, why: "not an SVG document" };
  const found = inspect(svg);
  const active: string[] = [];
  if (found.scripts > 0) active.push(`${found.scripts} <script>`);
  if (found.foreignObjects > 0) active.push(`${found.foreignObjects} <foreignObject>`);
  if (found.externalUrls.length > 0) active.push(`external ref ${found.externalUrls[0]}`);
  // inspect() demands every href be a data: URI, which is the right rule for a
  // rendered diagram but not for a source icon: `<use href="#id">` and paint
  // servers reference the icon's own document and fetch nothing.
  const offsite = [...svg.matchAll(/(?:xlink:)?href="([^"]*)"/g)]
    .map((m) => m[1]!)
    .filter((h) => !h.startsWith("#") && !h.startsWith("data:"));
  if (offsite.length > 0) active.push(`an off-document href (${offsite[0]})`);
  if (/\son[a-z]+\s*=/.test(svg)) active.push("an inline event handler");
  if (active.length > 0) return { ok: false, why: active.join(", "), fatal: true };
  if (!/viewBox\s*=/.test(svg)) return { ok: false, why: "no viewBox — d2 cannot scale it" };
  return { ok: true };
}

interface Built {
  records: Record<string, IconRecord>;
  copies: Array<{ from: string; to: string }>;
  skipped: Rejected[];
  ambiguous: string[];
}

function build(pack: string, info: VendorPack, extracted: Array<{ root: string; label: string }>): Built {
  const records: Record<string, IconRecord> = {};
  const copies: Array<{ from: string; to: string }> = [];
  const skipped: Rejected[] = [];
  const ambiguous = new Set<string>();
  // slug -> artwork digest -> the key it was stored under. Keyed by digest and
  // not merely by "whoever claimed the bare name" so that two identical copies
  // still collapse when a third, different icon sorts ahead of them.
  const seen = new Map<string, Map<string, string>>();

  for (const { root, label } of extracted) {
    for (const abs of svgFiles(root)) {
      const verdict = screen(abs);
      if (!verdict.ok) {
        if (verdict.fatal) {
          fail(
            `${relative(root, abs)} in pack "${pack}" carries ${verdict.why}. Nothing was installed —`
              + ` an icon that reaches the network or runs script must not be embedded in a diagram.`,
          );
        }
        skipped.push({ file: relative(root, abs), why: verdict.why ?? "unusable" });
        continue;
      }
      const c = candidateFor(abs, root, info, label);
      const variants = seen.get(c.slug) ?? new Map<string, string>();
      if (variants.has(c.digest)) continue; // the same artwork filed twice by the vendor
      const qualified = `${c.qualifier}/${c.slug}`;
      let key = qualified;
      if (records[key]) {
        // Two different icons under one qualified name: only the vendor's own
        // full stem still separates them.
        key = `${c.qualifier}/${slugify(basename(c.abs, ".svg"))}`;
        if (records[key]) fail(`pack "${pack}": ${relative(root, abs)} collides with an icon already registered as ${key}`);
      }
      const record: IconRecord = { set: pack, name: c.slug, file: `${key}.svg`, license: info.license };
      records[key] = record;
      copies.push({ from: abs, to: `${key}.svg` });
      if (variants.size === 0) records[c.slug] = record;
      else ambiguous.add(c.slug);
      variants.set(c.digest, key);
      seen.set(c.slug, variants);
    }
  }
  return { records, copies, skipped, ambiguous: [...ambiguous].sort() };
}

function notice(info: VendorPack, count: number): string {
  return [
    `${info.title}`,
    ``,
    `Vendor:   ${info.vendor}`,
    `Source:   ${info.landingUrl}`,
    `Terms:    ${info.termsUrl}`,
    `Licence:  ${info.license}`,
    ``,
    info.grant === "absent"
      ? `NO LICENCE IS GRANTED FOR THIS ARTWORK. It was fetched from the vendor's own`
        + `\nendpoint onto this machine and must not be redistributed.`
      : `This artwork is licensed by the vendor, NOT by AgentKit, and is not covered by`
        + `\nthis repository's licence. It must not be redistributed.`,
    ``,
    `Terms, verbatim:`,
    ...info.terms.map((t) => `\n  ${t}`),
    ``,
    `Archives fetched:`,
    ...info.archives.map((a) => `  ${a.url}\n    sha256 ${a.sha256}`),
    ``,
    `${count} icon(s) extracted verbatim by ${FETCH_SCRIPT}. Vendor logos are`,
    `trademarks of their respective owners, reproduced unmodified for nominative`,
    `identification only. They must never be recoloured, cropped, rotated,`,
    `distorted, or theme-filtered.`,
    ``,
  ].join("\n");
}

function printTerms(pack: string, info: VendorPack): void {
  console.log(`\n${info.title} — ${info.vendor}`);
  console.log(`  Licence: ${info.license}`);
  console.log(`  Terms:   ${info.termsUrl}`);
  if (info.grant === "absent") {
    console.log(`  WARNING: the vendor grants no licence for this set. Read the terms before fetching.`);
  }
  for (const t of info.terms) console.log(`\n  ${t}`);
  const bytes = info.archives.reduce((n, a) => n + (a.bytes ?? 0), 0);
  console.log(`\n  ${info.archives.length} archive(s), ~${Math.round(bytes / 1024)} KiB, from:`);
  for (const a of info.archives) console.log(`    ${a.url}`);
  console.log(`\nRe-run with --accept-terms to fetch:\n  bun ${FETCH_SCRIPT} ${pack} --accept-terms\n`);
}

function listPacks(registry: Record<string, VendorPack>, root: string): void {
  console.log(`vendor icon packs (registry: ${registryPath()})`);
  console.log(`install root: ${root}  [override with AGENTKIT_DIAGRAM_VENDOR_ICONS]\n`);
  for (const [id, info] of Object.entries(registry)) {
    const state = existsSync(join(packDir(id, root), "manifest.json")) ? "installed" : "not installed";
    console.log(`  ${id.padEnd(8)} ${state.padEnd(14)} ${info.title}`);
  }
  console.log(`\nfetch one with: bun ${FETCH_SCRIPT} <pack> --accept-terms`);
}

function listIcons(pack: string, root: string, filter?: string): void {
  const path = join(packDir(pack, root), "manifest.json");
  if (!existsSync(path)) fail(`pack "${pack}" is not installed — bun ${FETCH_SCRIPT} ${pack} --accept-terms`);
  const m: Record<string, IconRecord> = JSON.parse(readFileSync(path, "utf8"));
  const keys = Object.keys(m).filter((k) => !filter || k.includes(filter)).sort();
  for (const k of keys) console.log(`@${pack}:${k}`);
  console.log(`\n${keys.length} key(s)${filter ? ` matching "${filter}"` : ""} in pack "${pack}"`);
}

async function main(): Promise<void> {
  const registry = packs(arg("registry") ?? registryPath());
  const root = arg("root") ?? vendorRoot();
  const pack = process.argv.slice(2).find((a) => !a.startsWith("--") && a in registry);

  if (!pack) {
    const named = process.argv.slice(2).find((a) => !a.startsWith("--"));
    if (named) {
      console.error(`fetch-icons: no vendor pack "${named}" — known packs: ${Object.keys(registry).join(", ")}\n`);
    }
    listPacks(registry, root);
    process.exit(named ? 1 : 0);
  }
  const info = registry[pack]!;

  if (flag("list")) return listIcons(pack, root, arg("filter"));
  if (!flag("accept-terms")) {
    printTerms(pack, info);
    process.exit(2);
  }

  const dest = packDir(pack, root);
  const stamp = join(dest, "fetched.json");
  const pins = info.archives.map((a) => a.sha256);
  if (!flag("force") && existsSync(stamp)) {
    const prev = JSON.parse(readFileSync(stamp, "utf8"));
    if (JSON.stringify(prev.pins) === JSON.stringify(pins)) {
      console.log(`${pack}: already installed at ${dest} (${prev.icons} icons) — pass --force to refetch`);
      return;
    }
  }

  const work = mkdtempSync(join(tmpdir(), `fetch-icons-${pack}-`));
  try {
    const extracted: Array<{ root: string; label: string }> = [];
    for (const [i, archive] of info.archives.entries()) {
      const label = archive.label ?? (info.archives.length > 1 ? slugify(basename(new URL(archive.url).pathname, ".zip")) : pack);
      console.log(`${pack}: fetching ${archive.url}`);
      const buf = await readArchive(archive.url);
      verifyPin(archive, buf);
      const into = join(work, `a${i}`);
      unzipTo(buf, into);
      extracted.push({ root: join(into, "tree"), label });
    }

    const built = build(pack, info, extracted);
    const staging = join(work, "staged");
    for (const copy of built.copies) {
      const target = join(staging, copy.to);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(copy.from, target);
    }
    const count = built.copies.length;
    writeFileSync(join(staging, "manifest.json"), JSON.stringify(sortKeys(built.records), null, 2) + "\n");
    writeFileSync(join(staging, "NOTICE"), notice(info, count));
    writeFileSync(
      join(staging, "fetched.json"),
      JSON.stringify({ pack, pins, icons: count, fetchedAt: new Date().toISOString() }, null, 2) + "\n",
    );
    for (const keep of info.keepFiles ?? []) {
      for (const { root: tree } of extracted) {
        const hit = findByName(tree, keep);
        if (hit) copyFileSync(hit, join(staging, basename(hit)));
      }
    }

    // Swapped in whole: a half-written tree would resolve some icons and not
    // others, which reads as a missing icon rather than an interrupted fetch.
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(staging, dest);
    report(pack, dest, count, built);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function report(pack: string, dest: string, count: number, built: Built): void {
  console.log(`${pack}: ${count} icons -> ${dest}`);
  if (built.skipped.length > 0) {
    console.log(`${pack}: skipped ${built.skipped.length} unusable file(s):`);
    for (const s of built.skipped.slice(0, 5)) console.log(`  ${s.file} — ${s.why}`);
    if (built.skipped.length > 5) console.log(`  …and ${built.skipped.length - 5} more`);
  }
  if (built.ambiguous.length > 0) {
    console.log(
      `${pack}: ${built.ambiguous.length} name(s) exist more than once with different artwork; the bare`
        + ` name resolves to the first and the others are reachable only qualified —`
        + ` ${built.ambiguous.slice(0, 5).join(", ")}`,
    );
  }
  console.log(`${pack}: reference an icon as @${pack}:<name>; list them with bun ${FETCH_SCRIPT} ${pack} --list`);
}

function sortKeys(records: Record<string, IconRecord>): Record<string, IconRecord> {
  return Object.fromEntries(Object.entries(records).sort(([a], [b]) => a.localeCompare(b)));
}

function findByName(dir: string, name: string): string | undefined {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findByName(abs, name);
      if (hit) return hit;
    } else if (entry.name === name) return abs;
  }
  return undefined;
}

if (import.meta.main) await main();

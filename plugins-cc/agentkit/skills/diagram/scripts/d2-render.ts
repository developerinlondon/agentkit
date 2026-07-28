#!/usr/bin/env bun
// Renders a .d2 file to a self-contained, house-themed SVG plus a PNG twin.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { expandIconRefs, IconError } from "./icons.ts";
import {
  applyHouseAttributes,
  D2_PIN,
  dropBackgroundRect,
  retargetDarkTheme,
  SvgError,
  verifySelfContained,
} from "./d2-svg.ts";

function fail(msg: string): never {
  console.error(`d2-render: ${msg}`);
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

const INSTALL_HINT = `install it from https://github.com/terrastruct/d2/releases/tag/v${D2_PIN}`;

export function parseVersion(output: string): string {
  return output.trim().replace(/^v/, "");
}

function checkPin(): void {
  let raw: string;
  try {
    raw = execFileSync("d2", ["--version"], { encoding: "utf8" });
  } catch {
    fail(`d2 not found on PATH — this skill pins d2 v${D2_PIN}; ${INSTALL_HINT}`);
  }
  const found = parseVersion(raw);
  if (found !== D2_PIN) {
    fail(
      `d2 v${found} on PATH but this skill pins v${D2_PIN} — renders are only `
        + `reproducible on the pinned build; ${INSTALL_HINT}`,
    );
  }
}

const input = arg("in") ?? fail("--in <file.d2> is required");
if (!existsSync(input)) fail(`no such file: ${input}`);
const output = arg("out") ?? input.replace(/\.d2$/, "") + ".svg";
const png = arg("png");
const label = arg("label") ?? basename(input).replace(/\.d2$/, "").replaceAll("-", " ");

checkPin();

let expanded: { source: string; count: number };
try {
  expanded = expandIconRefs(readFileSync(input, "utf8"));
} catch (e) {
  if (e instanceof IconError) fail(`${input}: ${e.message}`);
  throw e;
}

const work = mkdtempSync(join(tmpdir(), "d2-render-"));
let svg: string;
try {
  const staged = join(work, basename(input));
  writeFileSync(staged, expanded.source);
  const rendered = join(work, "out.svg");
  const d2Args = [
    "--omit-version",
    "--no-xml-tag",
    "--bundle",
    // elk, not d2's dagre default: dagre overlaps sibling containers, which in
    // a trust-boundary diagram reads as a boundary that does not hold.
    `--layout=${arg("layout") ?? "elk"}`,
    `--theme=${arg("theme") ?? "0"}`,
    `--dark-theme=${arg("dark-theme") ?? "200"}`,
    `--pad=${arg("pad") ?? "40"}`,
  ];
  const salt = arg("salt");
  if (salt) d2Args.push(`--salt=${salt}`);
  try {
    execFileSync("d2", [...d2Args, staged, rendered], { encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    fail(`d2 failed to compile ${input}:\n${(err.stderr ?? err.message).trim()}`);
  }
  svg = readFileSync(rendered, "utf8");
} finally {
  rmSync(work, { recursive: true, force: true });
}

try {
  svg = retargetDarkTheme(svg);
  if (!flag("keep-background")) {
    const stripped = dropBackgroundRect(svg);
    if (!stripped.dropped) {
      console.error("d2-render: warning — no background rect matched; the figure island may be covered");
    }
    svg = stripped.svg;
  }
  svg = applyHouseAttributes(svg, label);
  verifySelfContained(svg, expanded.count);
} catch (e) {
  if (e instanceof SvgError) fail(e.message);
  throw e;
}

writeFileSync(output, svg);

if (png) await rasterize(svg, resolve(png));
console.log(`${output}${expanded.count > 0 ? ` (${expanded.count} icon(s) embedded)` : ""}`);

// Agents read PNGs, not SVGs. d2's own PNG export shells out to a Playwright
// download that is unavailable offline, so the raster is taken here instead.
async function rasterize(markup: string, target: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "d2-png-"));
  try {
    const box = markup.match(/viewBox="([\d.eE+-]+) ([\d.eE+-]+) ([\d.eE+-]+) ([\d.eE+-]+)"/);
    if (!box) fail("cannot rasterize: no viewBox on the rendered SVG");
    const w = Math.ceil(Number(box[3]));
    const h = Math.ceil(Number(box[4]));
    // The shipped SVG is fluid (width:100%), which collapses to nothing in a
    // screenshot page; the raster copy is pinned back to its natural size.
    const sized = markup.replace(/\bwidth="100%" style="height:auto"/, `width="${w}" height="${h}"`);
    const page = join(dir, "page.html");
    // Rasterised on the dark island: that is the authored default, and the
    // light rendering is derived by the page rather than authored separately.
    // display:block matters: an inline <svg> sits on the text baseline, and the
    // descender gap pushes the last rows out of a viewport sized to the viewBox.
    writeFileSync(
      page,
      `<!doctype html><meta charset="utf-8"><style>`
        + `html,body{margin:0;padding:0;background:#0e0f12}svg{display:block}</style>`
        + `<body>${sized}</body>`,
    );
    const chrome = chromePath();
    // A viewport sized exactly to the viewBox clips the last rows of tall
    // shapes. Content is anchored top-left, so slack only adds background —
    // and this raster exists to be looked at, not to be shipped.
    execFileSync(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=2",
        `--window-size=${w + 40},${h + 100}`,
        `--screenshot=${target}`,
        page,
      ],
      { stdio: "pipe", timeout: 120000 },
    );
  } catch (e) {
    fail(`could not rasterize PNG: ${(e as Error).message.split("\n")[0]}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!existsSync(target)) fail(`headless browser produced no PNG at ${target}`);
}

function chromePath(): string {
  const candidates = [
    process.env.AGENTKIT_CHROMIUM,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/opt/google/chrome/chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) if (existsSync(c)) return c;
  fail("no Chromium/Chrome found for PNG rasterization — set AGENTKIT_CHROMIUM");
}

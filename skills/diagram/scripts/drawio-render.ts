#!/usr/bin/env bun
// Renders a .drawio file to a self-contained, house-themed SVG plus a PNG twin.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { flattenForMarkdown, SvgError, verifySelfContained } from "./d2-svg.ts";
import {
  DrawioError,
  INSTALL_HINT,
  type Launcher,
  parseVersion,
  resolveLauncher,
  run,
} from "./drawio-binary.ts";
import {
  applyHouseAttributes,
  DRAWIO_PIN,
  isCompressed,
  namespaceIds,
  plateBackground,
  saltFor,
  screenSource,
  stripPrologue,
} from "./drawio-svg.ts";

function fail(msg: string): never {
  console.error(`drawio-render: ${msg}`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > 0 ? process.argv[i + 1] : undefined;
  if (v?.startsWith("--")) fail(`--${name} is missing its value`);
  return v;
}

// Resolved after the source has been screened, so a file that could never render
// correctly is refused on any machine, not only where draw.io is installed.
let launcher: Launcher | undefined;

function drawio(args: string[]): string {
  try {
    launcher ??= resolveLauncher(process.env, homedir(), process.platform);
    return run(launcher, args);
  } catch (e) {
    if (e instanceof DrawioError) fail(e.message);
    throw e;
  }
}

function checkPin(): void {
  const found = parseVersion(drawio(["--version"]));
  if (found !== DRAWIO_PIN) {
    fail(
      `draw.io v${found || "?"} at ${launcher?.binary} but this skill pins v${DRAWIO_PIN} — `
        + `renders are only reproducible on the pinned build; ${INSTALL_HINT}`,
    );
  }
}

const input = arg("in") ?? fail("--in <file.drawio> is required");
if (!existsSync(input)) fail(`no such file: ${input}`);
const output = arg("out") ?? input.replace(/\.drawio$/, "") + ".svg";
const png = arg("png");
const border = arg("border") ?? "8";
const page = arg("page-index") ?? "1";
const label = arg("label") ?? basename(input).replace(/\.drawio$/, "").replaceAll("-", " ");

const source = readFileSync(input, "utf8");
if (isCompressed(source)) {
  fail(
    `${input} stores its diagram compressed, so its cell styles cannot be screened — `
      + "re-save with Extras ▸ Edit Diagram, or File ▸ Properties ▸ Compressed off.",
  );
}
const problems = screenSource(source);
if (problems.length > 0) {
  const shown = problems.slice(0, 6).map((p) => `  ${p.cellId}: ${p.fix}`).join("\n");
  fail(
    `${input} carries ${problems.length} label style(s) that export as <foreignObject>, which `
      + `GitHub and GitLab will not render inside an <img>:\n${shown}`,
  );
}

checkPin();

// Light, always: draw.io's dark theme remaps every authored colour, and the
// register forbids recolouring the vendor artwork those fills carry.
function exportArgs(format: string, target: string, extra: string[] = []): string[] {
  return [
    "--disable-update",
    "--export",
    `--format=${format}`,
    "--theme=light",
    `--border=${border}`,
    `--page-index=${page}`,
    ...extra,
    "--output",
    target,
    resolve(input),
  ];
}

const work = mkdtempSync(join(tmpdir(), "drawio-render-"));
let svg: string;
try {
  const rendered = join(work, "out.svg");
  drawio(exportArgs("svg", rendered, ["--embed-svg-fonts=false"]));
  if (!existsSync(rendered)) fail("draw.io reported success but wrote no SVG");
  svg = readFileSync(rendered, "utf8");
} finally {
  rmSync(work, { recursive: true, force: true });
}

try {
  svg = stripPrologue(svg);
  svg = namespaceIds(svg, arg("salt") ?? saltFor(basename(output)));
  svg = plateBackground(svg);
  svg = applyHouseAttributes(svg, label);
  svg = flattenForMarkdown(svg);
  verifySelfContained(svg, 0);
} catch (e) {
  if (e instanceof SvgError) fail(e.message);
  throw e;
}

writeFileSync(output, svg);

if (png) {
  drawio(exportArgs("png", resolve(png), ["--scale=2"]));
  if (!existsSync(resolve(png))) fail(`draw.io produced no PNG at ${png}`);
}

console.log(output);

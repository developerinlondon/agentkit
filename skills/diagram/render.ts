#!/usr/bin/env bun
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

declare global {
  interface Window {
    renderExcalidrawToSvg: (scene: unknown) => Promise<string>;
  }
}

function fail(msg: string): never {
  console.error(`diagram-render: ${msg}`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > 0 ? process.argv[i + 1] : undefined;
  if (v?.startsWith("--")) fail(`--${name} is missing its value`);
  return v;
}

const input = arg("in") ?? fail("--in <file.excalidraw> is required");
const output = arg("out") ?? input.replace(/\.excalidraw$/, "") + ".svg";
if (!existsSync(input)) fail(`no such file: ${input}`);

let scene: { type?: string; elements?: unknown[] };
try {
  scene = JSON.parse(await readFile(input, "utf8"));
} catch (e) {
  fail(`${input} is not valid JSON: ${(e as Error).message}`);
}
if (scene.type !== "excalidraw") fail(`expected type "excalidraw", got "${scene.type}"`);
if (!Array.isArray(scene.elements) || scene.elements.length === 0) {
  fail("scene has no elements — nothing to render");
}

const bundle = join(import.meta.dir, "renderer/bundle.js");
if (!existsSync(bundle)) {
  console.error("diagram-render: building renderer bundle (first run)…");
  try {
    execSync("bun run build", { cwd: import.meta.dir, stdio: "inherit" });
  } catch {
    fail(`renderer bundle build failed — run: cd ${import.meta.dir} && bun install && bun run build`);
  }
}

// Chromium resolution order: explicit env, playwright's own cache, system installs.
function chromiumPath(): string {
  const envPath = process.env.AGENTKIT_CHROMIUM;
  if (envPath && existsSync(envPath)) return envPath;
  const candidates = [
    "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome", "/opt/google/chrome/chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return ""; // let playwright try its default cache
}

const { chromium } = await import("playwright-core");
const exe = chromiumPath();
const browser = await chromium
  .launch(exe ? { executablePath: exe } : {})
  .catch((e: Error) =>
    fail(`no usable Chromium (${e.message.split("\n")[0]}) — set AGENTKIT_CHROMIUM or run: bunx playwright install chromium`)
  );

// Failures inside the try are thrown (not fail()ed) so the finally can close
// the browser — process.exit skips finally blocks.
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.addScriptTag({ path: bundle, type: "module" });
  await page
    .waitForFunction(() => typeof window.renderExcalidrawToSvg === "function", undefined, { timeout: 15000 })
    .catch(() => {
      throw new Error(`renderer bundle failed to initialize${errors.length ? `: ${errors[0]}` : ""}`);
    });
  const svg: string = await page.evaluate((s) => window.renderExcalidrawToSvg(s), scene);
  if (!svg.startsWith("<svg")) throw new Error("renderer returned no SVG");
  await writeFile(output, svg).catch((e: Error) => {
    throw new Error(`cannot write ${output}: ${e.message}`);
  });
  const png = arg("png");
  if (png) {
    // A PNG twin lets the authoring agent LOOK at the result (Read renders
    // images, not SVG) for the render-view-fix loop.
    await page.setContent(`<!doctype html><body style="margin:0;background:#fff">${svg}</body>`);
    const el = page.locator("svg").first();
    await el.screenshot({ path: png }).catch((e: Error) => {
      throw new Error(`cannot write ${png}: ${e.message}`);
    });
  }
  console.log(output);
} catch (e) {
  await browser.close();
  fail((e as Error).message);
} finally {
  await browser.close().catch(() => {});
}

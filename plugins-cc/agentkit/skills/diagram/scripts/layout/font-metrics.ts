#!/usr/bin/env bun
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHARSET, METRICS_PATH, UNIT } from "./measure.ts";

const skillDir = join(import.meta.dir, "../..");
const bundle = join(skillDir, "renderer/bundle.js");

function chromiumPath(): string {
  const envPath = process.env.AGENTKIT_CHROMIUM;
  if (envPath && existsSync(envPath)) return envPath;
  for (
    const c of [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
      "/opt/google/chrome/chrome",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]
  ) if (existsSync(c)) return c;
  return "";
}

function probeScene(text: string, fontFamily: number) {
  return {
    type: "excalidraw",
    elements: [{
      id: "probe",
      type: "text",
      x: 0,
      y: 0,
      width: 4000,
      height: 40,
      angle: 0,
      strokeColor: "#000000",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 0,
      opacity: 100,
      seed: 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      groupIds: [],
      frameId: null,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
      text,
      originalText: text,
      fontSize: 20,
      fontFamily,
      textAlign: "left",
      verticalAlign: "top",
      containerId: null,
      autoResize: true,
      lineHeight: 1.25,
    }],
    appState: {},
    files: null,
  };
}

if (!existsSync(bundle)) {
  console.error(`font-metrics: no renderer bundle — run: cd ${skillDir} && bun install && bun run build`);
  process.exit(1);
}

const { chromium } = await import("playwright-core");
const exe = chromiumPath();
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage();
await page.setContent("<!doctype html><html><body></body></html>");
await page.addScriptTag({ path: bundle, type: "module" });
await page.waitForFunction(
  () => typeof (globalThis as { renderExcalidrawToSvg?: unknown }).renderExcalidrawToSvg === "function",
  undefined,
  { timeout: 20000 },
);

const families: Record<string, Record<string, number>> = {};
const chars = [...CHARSET];
for (const fontFamily of [1, 3]) {
  // The renderer embeds only the faces the probe text actually uses, so
  // measuring against those faces is measuring the shipped SVG's own font.
  const svg: string = await page.evaluate(
    (s) => (globalThis as unknown as { renderExcalidrawToSvg: (x: unknown) => Promise<string> }).renderExcalidrawToSvg(s),
    probeScene(CHARSET, fontFamily),
  );
  const faces = [...svg.matchAll(/@font-face\s*\{\s*font-family:\s*([^;]+);\s*src:\s*url\((data:font\/woff2;base64,[^)]+)\)/g)]
    .map((m) => ({ family: m[1].trim(), src: m[2] }));
  if (faces.length === 0) throw new Error(`fontFamily ${fontFamily}: renderer embedded no font face`);
  const widths = await page.evaluate(
    async ({ faces, chars, unit }) => {
      for (const f of faces) {
        const face = new FontFace(f.family, `url(${f.src})`);
        await face.load();
        (document as unknown as { fonts: { add: (f: FontFace) => void } }).fonts.add(face);
      }
      const embedded = faces.map((f) => `"${f.family}"`).join(", ");
      const ctx = document.createElement("canvas").getContext("2d")!;
      // A glyph the embedded faces lack falls through to whichever font the
      // stack ends in, and two different tails disagree on its advance. Only a
      // glyph the faces really carry measures the same behind both.
      const measure = (c: string, tail: string) => {
        ctx.font = `${unit}px ${embedded}, ${tail}`;
        return ctx.measureText(c).width;
      };
      const out: Record<string, number> = {};
      for (const c of chars) {
        const serif = measure(c, "serif");
        if (serif === measure(c, "monospace")) out[c] = serif;
      }
      return out;
    },
    { faces, chars, unit: UNIT },
  );
  families[String(fontFamily)] = widths;
}

await browser.close();
writeFileSync(METRICS_PATH, `${JSON.stringify({ unit: UNIT, families }, null, 2)}\n`);
console.log(METRICS_PATH);

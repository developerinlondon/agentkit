#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { build } from "./layout/build.ts";
import { parseSpec } from "./layout/spec.ts";

function fail(msg: string): never {
  console.error(`diagram-layout: ${msg}`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > 0 ? process.argv[i + 1] : undefined;
  if (v?.startsWith("--")) fail(`--${name} is missing its value`);
  return v;
}

const input = arg("in") ?? fail("--in <spec.diagram.yaml> is required");
const output = arg("out") ?? input.replace(/\.(diagram\.)?(ya?ml|json)$/, "") + ".excalidraw";
if (!existsSync(input)) fail(`no such file: ${input}`);

let built;
try {
  built = build(parseSpec(await readFile(input, "utf8")));
} catch (e) {
  fail((e as Error).message);
}
if (built.evidence) console.error(`diagram-layout: ${built.evidence}`);
for (const w of built.warnings) console.error(`diagram-layout: warning: ${w}`);
await writeFile(output, `${JSON.stringify(built.scene, null, 1)}\n`).catch((e: Error) =>
  fail(`cannot write ${output}: ${e.message}`)
);
console.error(`diagram-layout: ${Math.round(built.width)}x${Math.round(built.height)}px`);
console.log(output);

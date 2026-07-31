import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { injectBanner } from "./archive-banner";

const [slug, root] = process.argv.slice(2);
if (!slug || !root) {
	console.error("usage: inject-banner <slug> <dir>");
	process.exit(2);
}

function htmlFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) found.push(...htmlFiles(path));
		else if (entry.endsWith(".html")) found.push(path);
	}
	return found;
}

let injected = 0;
let present = 0;
const unwritable: string[] = [];

for (const file of htmlFiles(root)) {
	const result = injectBanner(readFileSync(file, "utf8"), slug);
	if (result.injected) {
		writeFileSync(file, result.html);
		injected++;
	} else if (result.reason === "already-present") {
		present++;
	} else {
		unwritable.push(file);
	}
}

// A page the injector could not reach is a page that strands its reader, and a
// count printed alongside the successes would read as a rounding error.
if (unwritable.length > 0) {
	console.error(`inject-banner: no <body> to inject into: ${unwritable.slice(0, 3).join(", ")}`);
	process.exit(1);
}

console.log(`inject-banner: ${slug} — ${injected} injected, ${present} already carried the banner`);

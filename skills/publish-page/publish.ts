#!/usr/bin/env bun
import { marked } from "marked";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}(\/[a-z0-9][a-z0-9-]{0,63}){0,3}$/;

function fail(msg: string): never {
  console.error(`publish-page: ${msg}`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const slug = arg("slug") ?? fail("--slug is required");
const file = arg("file") ?? fail("--file is required");
const template = arg("template") ?? "doc";
const noGit = process.argv.includes("--no-git");
if (!SLUG_RE.test(slug)) fail(`invalid slug "${slug}" (lowercase a-z0-9-, max 4 segments)`);
if (!["doc", "deck", "raw"].includes(template)) fail(`unknown template "${template}"`);
if (!existsSync(file)) fail(`no such file: ${file}`);

const endpoint = process.env.AGENTKIT_PAGES_ENDPOINT ?? "https://pages.agentkit.sbs";
const repo = process.env.AGENTKIT_PAGES_REPO ?? join(homedir(), "code/agentkit-pages");
const tokenPath = join(homedir(), ".config/agentkit/pages-token");
if (!existsSync(tokenPath)) fail(`publish token missing at ${tokenPath}`);
const token = (await readFile(tokenPath, "utf8")).trim();

const source = await readFile(file, "utf8");
const isMd = file.endsWith(".md");
const title = arg("title")
  ?? source.match(/^#\s+(.+)$/m)?.[1]
  ?? source.match(/<title>([^<]+)<\/title>/)?.[1]
  ?? slug;

async function render(): Promise<string> {
  if (template === "raw") return source;
  const themePath = join(repo, "themes", `${template}.html`);
  if (!existsSync(themePath)) fail(`theme not found: ${themePath} (clone agentkit-pages?)`);
  const theme = await readFile(themePath, "utf8");
  let content: string;
  if (template === "deck") {
    const parts = isMd
      ? source.split(/^---$/m).map((s) => marked.parse(s) as string)
      : source.split(/<hr\s*\/?>/i);
    content = parts
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => `<section class="slide">\n${s}\n</section>`)
      .join("\n");
  } else {
    content = isMd ? (marked.parse(source) as string) : source;
  }
  return theme.replace("{{TITLE}}", title.replace(/[<>&]/g, "")).replace("{{CONTENT}}", content);
}

const html = await render();
if (Buffer.byteLength(html) > 5 * 1024 * 1024) fail("rendered page exceeds 5 MB");

const res = await fetch(`${endpoint}/api/pages/${slug}`, {
  method: "PUT",
  headers: { authorization: `Bearer ${token}` },
  body: html,
});
if (!res.ok) fail(`publish failed: HTTP ${res.status} ${await res.text()}`);
const { url } = (await res.json()) as { url: string };

if (!noGit) {
  if (!existsSync(join(repo, ".git"))) fail(`pages repo not found at ${repo} (published, but not committed)`);
  const srcDir = join(repo, "src", slug);
  const distDir = join(repo, "dist", slug);
  await mkdir(srcDir, { recursive: true });
  await mkdir(distDir, { recursive: true });
  await writeFile(join(srcDir, isMd ? "content.md" : "content.html"), source);
  await writeFile(
    join(srcDir, "meta.yaml"),
    `title: ${JSON.stringify(title)}\ntemplate: ${template}\nslug: ${slug}\n`,
  );
  await writeFile(join(distDir, "index.html"), html);
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  git("add", `src/${slug}`, `dist/${slug}`);
  const commit = git("commit", "-m", `pages: publish ${slug}`);
  if (commit.exitCode === 0) {
    const push = git("push");
    if (push.exitCode !== 0) console.error(`warning: git push failed — commit is local only:\n${push.stderr.toString()}`);
  } else if (!commit.stdout.toString().includes("nothing to commit")) {
    console.error(`warning: git commit failed:\n${commit.stderr.toString()}`);
  }
}

console.log(url);

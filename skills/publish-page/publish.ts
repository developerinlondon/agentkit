#!/usr/bin/env bun
import { marked } from "marked";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}(\/[a-z0-9][a-z0-9-]{0,63}){0,3}$/;

function fail(msg: string): never {
  console.error(`publish-page: ${msg}`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > 0 ? process.argv[i + 1] : undefined;
  if (v?.startsWith("--")) fail(`--${name} is missing its value (got "${v}")`);
  return v;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

const explicitSlug = arg("slug");
const name = arg("name");
const isDelete = process.argv.includes("--delete");
const file = arg("file");
const template = arg("template") ?? "doc";
let noGit = process.argv.includes("--no-git");
if (!explicitSlug && !name) fail("--name (cryptic URL, default) or --slug (readable URL) is required");
if (explicitSlug && !SLUG_RE.test(explicitSlug)) {
  fail(`invalid slug "${explicitSlug}" (lowercase a-z0-9-, max 4 segments)`);
}
if (name && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
  fail(`invalid name "${name}" (lowercase a-z0-9-)`);
}
if (!["doc", "deck", "raw"].includes(template)) fail(`unknown template "${template}"`);
if (!isDelete && !file) fail("--file is required");
if (!isDelete && !existsSync(file!)) fail(`no such file: ${file}`);

const endpoint = process.env.AGENTKIT_PAGES_ENDPOINT ?? "https://pages.agentkit.sbs";
const endpointHost = new URL(endpoint).hostname;
if (!endpoint.startsWith("https://") && !["127.0.0.1", "localhost"].includes(endpointHost)) {
  fail(`endpoint must be https (got ${endpoint}) — the bearer token would travel in cleartext`);
}
const repo = process.env.AGENTKIT_PAGES_REPO ?? join(homedir(), "code/agentkit-pages");
const tokenPath = join(homedir(), ".config/agentkit/pages-token");
if (!existsSync(tokenPath)) fail(`publish token missing at ${tokenPath}`);
const token = (await readFile(tokenPath, "utf8")).trim();

// Cryptic-but-deterministic slug: HMAC(slug key, name). The slug key is a
// dedicated secret — NOT the auth token — so rotating credentials never
// changes or orphans a URL, and a leaked slug key grants no write access.
// Generated once per install; copy the same key to other machines for
// cross-machine determinism.
const slugKeyPath = join(homedir(), ".config/agentkit/pages-slug-key");
async function slugKey(): Promise<string> {
  if (existsSync(slugKeyPath)) return (await readFile(slugKeyPath, "utf8")).trim();
  const key = randomBytes(32).toString("hex");
  await writeFile(slugKeyPath, key);
  await chmod(slugKeyPath, 0o600);
  console.error(`note: generated new slug key at ${slugKeyPath} — copy it to other machines for same-name URL determinism`);
  return key;
}
const slug = explicitSlug
  ?? createHmac("sha256", await slugKey()).update(name!).digest("hex").slice(0, 20);
const pageLabel = name ?? slug;

const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
const repoAvailable = () => existsSync(join(repo, ".git"));

function commitScoped(message: string, paths: string[]) {
  const staged = git("diff", "--cached", "--quiet", "--", ...paths);
  if (staged.exitCode === 0) return;
  // Pathspec-scoped commit: the clone is long-lived and shared — a bare
  // commit would sweep anything else staged into this publish.
  const commit = git("commit", "-m", message, "--", ...paths);
  if (commit.exitCode === 0) {
    const push = git("push");
    if (push.exitCode !== 0) {
      console.error(`warning: git push failed — commit is local only:\n${push.stderr.toString()}`);
    }
  } else {
    console.error(`warning: git commit failed:\n${commit.stderr.toString()}`);
  }
}

if (isDelete) {
  const res = await fetch(`${endpoint}/api/pages/${slug}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 404) fail(`no page at ${slug} — nothing deleted`);
  if (!res.ok) fail(`delete failed: HTTP ${res.status} ${await res.text()}`);
  if (!noGit && repoAvailable()) {
    await rm(join(repo, "src", slug), { recursive: true, force: true });
    await rm(join(repo, "dist", slug), { recursive: true, force: true });
    git("add", "-A", "--", `src/${slug}`, `dist/${slug}`);
    commitScoped(`pages: delete ${pageLabel}`, [`src/${slug}`, `dist/${slug}`]);
  }
  console.log(`deleted: ${endpoint}/${slug}`);
  process.exit(0);
}

const source = await readFile(file!, "utf8");
const isMd = /\.(md|markdown|mdown)$/i.test(file!);
const title = arg("title")
  ?? source.match(/^#\s+(.+)$/m)?.[1]
  ?? source.match(/<title>([^<]+)<\/title>/)?.[1]
  ?? pageLabel;

// Split markdown into slides on `---` lines, ignoring YAML frontmatter and
// `---` inside fenced code blocks — a naive regex split cuts fences in half.
function splitSlides(md: string): string[] {
  let lines = md.split("\n");
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (close > 0) lines = lines.slice(close + 1);
  }
  const slides: string[][] = [[]];
  let fence: string | null = null;
  for (const line of lines) {
    const open = line.match(/^\s*(```|~~~)/)?.[1];
    if (open) fence = fence === open ? null : fence ?? open;
    if (!fence && line.trim() === "---") slides.push([]);
    else slides[slides.length - 1].push(line);
  }
  return slides.map((s) => s.join("\n"));
}

async function render(): Promise<string> {
  if (template === "raw") return source;
  // Canonical themes live in the agentkit-pages repo; the skill bundles a copy
  // so publishing works on machines without the repo clone.
  const repoTheme = join(repo, "themes", `${template}.html`);
  const bundledTheme = join(import.meta.dir, "themes", `${template}.html`);
  const themePath = existsSync(repoTheme) ? repoTheme : bundledTheme;
  if (!existsSync(themePath)) fail(`theme not found: ${repoTheme} or ${bundledTheme}`);
  const theme = await readFile(themePath, "utf8");
  if (themePath === repoTheme && existsSync(bundledTheme)) {
    const bundled = await readFile(bundledTheme, "utf8");
    if (bundled !== theme) {
      console.error(`warning: bundled theme drifted from canonical ${repoTheme} — re-sync skills/publish-page/themes/`);
    }
  }
  let content: string;
  if (template === "deck") {
    const parts = isMd
      ? splitSlides(source).map((s) => marked.parse(s) as string)
      : source.split(/<hr\b[^>]*>/i);
    content = parts
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => `<section class="slide">\n${s}\n</section>`)
      .join("\n");
  } else {
    content = isMd ? (marked.parse(source) as string) : source;
  }
  // Function replacers: a plain string replacement expands $&, $`, $' found in
  // page content and silently corrupts the output.
  return theme
    .replaceAll("{{TITLE}}", () => escapeHtml(title))
    .replaceAll("{{CONTENT}}", () => content);
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

if (!noGit && !repoAvailable()) {
  console.error(`note: pages repo not found at ${repo} — published without canonical git commit`);
  noGit = true;
}
if (!noGit) {
  const srcDir = join(repo, "src", slug);
  const distDir = join(repo, "dist", slug);
  await mkdir(srcDir, { recursive: true });
  await mkdir(distDir, { recursive: true });
  await writeFile(join(srcDir, isMd ? "content.md" : "content.html"), source);
  await writeFile(
    join(srcDir, "meta.yaml"),
    `title: ${JSON.stringify(title)}\nname: ${JSON.stringify(pageLabel)}\ntemplate: ${template}\nslug: ${slug}\n`,
  );
  await writeFile(join(distDir, "index.html"), html);
  git("add", `src/${slug}`, `dist/${slug}`);
  commitScoped(`pages: publish ${pageLabel}`, [`src/${slug}`, `dist/${slug}`]);
}

console.log(url);

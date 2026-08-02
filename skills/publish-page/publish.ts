#!/usr/bin/env bun
import { lintFigures } from "./lint.ts";
import { bundledThemePath, renderThemed } from "./render-html.ts";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
const repoCandidates = process.env.AGENTKIT_PAGES_REPO
  ? [process.env.AGENTKIT_PAGES_REPO]
  : [join(homedir(), "code/agentkit-pages"), join(homedir(), "code/agentkit/agentkit-pages")];
const foundRepo = repoCandidates.find((p) => existsSync(join(p, ".git")));
const repo = foundRepo ?? repoCandidates[0];
if (!foundRepo) {
  // Publishing without the clone silently uses bundled themes (which can lag
  // canonical) and skips the canonical git commit — both have bitten before.
  console.error(
    `warning: no agentkit-pages clone (looked at: ${repoCandidates.join(", ")}) — `
      + `publishing with BUNDLED themes (may lag canonical) and WITHOUT a canonical git commit`,
  );
}
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
  await writeFile(slugKeyPath, key, { mode: 0o600 });
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
  if (staged.exitCode !== 0) {
    // Pathspec-scoped commit: the clone is long-lived and shared — a bare
    // commit would sweep anything else staged into this publish.
    const commit = git("commit", "-m", message, "--", ...paths);
    if (commit.exitCode !== 0) {
      console.error(`warning: git commit failed:\n${commit.stderr.toString()}`);
      return;
    }
  } else {
    // Nothing newly staged — but a previously rejected push leaves committed
    // work stranded, and a re-run of the same command must still push it or
    // the printed remedy records nothing while exiting 0.
    const ahead = git("rev-list", "--count", "@{u}..HEAD");
    if (ahead.exitCode !== 0 || ahead.stdout.toString().trim() === "0") return;
  }
  // Bounded like the fetch: this is the other network operation, and it runs
  // after the page is already live — a prompting remote must not stall it.
  const push = Bun.spawnSync(["git", "-C", repo, "push"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (push.exitCode !== 0) {
    // The push can fail without any rejection (offline, no upstream), so the
    // message reports the failure and leaves the cause to git's own error.
    const done = isDelete ? "the page was deleted from the server" : "the page itself is live";
    console.error(
      `publish-page: the canonical push failed:\n`
        + push.stderr.toString()
        + `agentkit-pages history does NOT carry this ${isDelete ? "deletion" : "publish"}; ${done}.\n`
        + `if the push was rejected because the clone is behind: git -C ${repo} pull --rebase, then re-run the same command`,
    );
    process.exitCode = 1;
  }
}

if (isDelete) {
  const res = await fetch(`${endpoint}/api/pages/${slug}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  const gone = res.status === 404;
  if (!res.ok && !gone) fail(`delete failed: HTTP ${res.status} ${await res.text()}`);
  if (!noGit && repoAvailable()) {
    // A 404 is not always a dead end: a successful delete whose canonical push
    // was rejected leaves the server page gone and the deletion commit
    // stranded, and the advised re-run must still push that commit.
    const hadLocal = existsSync(join(repo, "src", slug)) || existsSync(join(repo, "dist", slug));
    // Scoped to THIS slug's history: a clone ahead on unrelated work must not
    // turn a mistyped delete into a reported success.
    const ahead = git("rev-list", "--count", "@{u}..HEAD", "--", `src/${slug}`, `dist/${slug}`);
    const stranded = ahead.exitCode === 0 && ahead.stdout.toString().trim() !== "0";
    if (gone && !hadLocal && !stranded) fail(`no page at ${slug} — nothing deleted`);
    await rm(join(repo, "src", slug), { recursive: true, force: true });
    await rm(join(repo, "dist", slug), { recursive: true, force: true });
    git("add", "-A", "--", `src/${slug}`, `dist/${slug}`);
    commitScoped(`pages: delete ${pageLabel}`, [`src/${slug}`, `dist/${slug}`]);
  } else if (gone) {
    fail(`no page at ${slug} — nothing deleted`);
  }
  console.log(gone ? `no page on the server at ${slug} — canonical record updated` : `deleted: ${endpoint}/${slug}`);
  // Bare exit() honors the exitCode a rejected canonical push set; exit(0) discards it.
  process.exit();
}

const source = await readFile(file!, "utf8");
const isMd = /\.(md|markdown|mdown)$/i.test(file!);
const title = arg("title")
  ?? source.match(/^#\s+(.+)$/m)?.[1]
  ?? source.match(/<title>([^<]+)<\/title>/)?.[1]
  ?? pageLabel;

async function render(): Promise<string> {
  if (template === "raw") return source;
  // Canonical themes live in the agentkit-pages repo; the skill bundles a copy
  // so publishing works on machines without the repo clone.
  const repoTheme = join(repo, "themes", `${template}.html`);
  const bundledTheme = bundledThemePath(template);
  const themePath = existsSync(repoTheme) ? repoTheme : bundledTheme;
  if (!existsSync(themePath)) fail(`theme not found: ${repoTheme} or ${bundledTheme}`);
  if (themePath === repoTheme) {
    // A behind clone serves CSS upstream already replaced, and nothing fails:
    // the page publishes with current markup and stale rules. Refuse only when
    // upstream actually changed themes/ — merge-base..upstream, so a clone
    // that is merely ahead or behind on other paths still publishes.
    // Bounded and prompt-free: an unreachable remote or a credential helper
    // wanting input must degrade to the warning, not stall the publish.
    const fetched = Bun.spawnSync(["git", "-C", repo, "fetch", "--quiet"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    if (fetched.exitCode !== 0) {
      console.error(`warning: could not verify the pages clone is current (git fetch failed) — publishing with its themes as-is`);
    } else {
      const upstream = git("diff", "--quiet", "HEAD...@{u}", "--", "themes/");
      if (upstream.exitCode === 1) {
        const behind = git("rev-list", "--count", "HEAD..@{u}").stdout.toString().trim();
        // Remedy last and nothing after it: this text gets pasted by agents,
        // and --rebase because a stranded local commit makes a plain pull abort.
        fail(`pages clone is ${behind} commit(s) behind and themes/ changed upstream — publishing now would serve stale CSS. run: git -C ${repo} pull --rebase`);
      } else if (upstream.exitCode !== 0) {
        console.error(`warning: could not compare the pages clone against an upstream — publishing with its themes as-is`);
      }
    }
    if (existsSync(bundledTheme)) {
      const [canonical, bundled] = await Promise.all([readFile(repoTheme, "utf8"), readFile(bundledTheme, "utf8")]);
      if (bundled !== canonical) {
        console.error(`warning: bundled theme lags canonical ${repoTheme} — re-sync skills/publish-page/themes/`);
      }
    }
  }
  try {
    return await renderThemed({ source, isMd, template, title, themePath });
  } catch (error) {
    fail((error as Error).message);
  }
}

const html = await render();
const lint = lintFigures(html, process.argv.includes("--allow-bare-svg"));
for (const warning of lint.warnings) console.error(`publish-page: warning: ${warning}`);
if (lint.errors.length > 0) fail(lint.errors.join("\n"));
if (Buffer.byteLength(html) > 5 * 1024 * 1024) {
  const hint = html.includes("mermaid.initialize")
    ? " (the inlined mermaid runtime accounts for ~3.4 MB — diagram pages have ~1.4 MB left for content; split the page or drop diagrams)"
    : "";
  fail(`rendered page exceeds 5 MB${hint}`);
}

const res = await fetch(`${endpoint}/api/pages/${slug}`, {
  method: "PUT",
  headers: { authorization: `Bearer ${token}` },
  body: html,
});
if (!res.ok) fail(`publish failed: HTTP ${res.status} ${await res.text()}`);
const { url } = (await res.json()) as { url: string };

if (!noGit && !foundRepo) noGit = true;
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

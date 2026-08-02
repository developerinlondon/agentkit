import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
const bundledDoc = readFileSync(join(repoRoot, "skills/publish-page/themes/doc.html"), "utf8");

let server: ReturnType<typeof Bun.serve>;
let puts = 0;
// Mirrors the production worker: a DELETE of an absent page 404s, which is
// exactly what a delete-retry after a rejected push encounters.
const stored = new Set<string>();

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const key = new URL(req.url).pathname;
      if (req.method === "PUT") {
        puts++;
        stored.add(key);
        return Response.json({ url: `http://127.0.0.1:${server.port}/fake-slug` });
      }
      if (req.method === "DELETE") {
        if (!stored.delete(key)) return new Response("not found\n", { status: 404 });
        return Response.json({ deleted: true });
      }
      return new Response("nope", { status: 405 });
    },
  });
});
afterAll(() => {
  server.stop(true);
  for (const base of worlds) rmSync(base, { recursive: true, force: true });
});

const worlds: string[] = [];

function sh(cwd: string, ...args: string[]) {
  const r = spawnSync(args[0]!, args.slice(1), { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return r.stdout;
}
const git = (cwd: string, ...args: string[]) =>
  sh(cwd, "git", "-c", "user.email=t@t", "-c", "user.name=t", ...args);
// Commits the clone holds that canonical does not — 0 means nothing stranded.
const ahead = (clone: string) => git(clone, "rev-list", "--count", "@{u}..HEAD").trim();

// origin (bare) + publisher clone + a second clone that advances origin.
function makeWorld(): { home: string; origin: string; mine: string; theirs: string; page: string } {
  const base = mkdtempSync(join(tmpdir(), "pages-freshness-"));
  worlds.push(base);
  const home = join(base, "home");
  mkdirSync(join(home, ".config/agentkit"), { recursive: true });
  writeFileSync(join(home, ".config/agentkit/pages-token"), "test-token\n");
  writeFileSync(join(home, ".config/agentkit/pages-slug-key"), "00".repeat(32));
  // publish.ts commits with the machine identity; the fake HOME must have one.
  writeFileSync(join(home, ".gitconfig"), "[user]\n\temail = t@t\n\tname = t\n");

  const origin = join(base, "origin.git");
  sh(base, "git", "init", "--bare", "-b", "main", origin);
  const seed = join(base, "seed");
  git(base, "clone", origin, seed);
  mkdirSync(join(seed, "themes"), { recursive: true });
  writeFileSync(join(seed, "themes/doc.html"), bundledDoc);
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "seed themes");
  git(seed, "push", "origin", "main");

  const mine = join(base, "mine");
  const theirs = join(base, "theirs");
  git(base, "clone", origin, mine);
  git(base, "clone", origin, theirs);

  const page = join(base, "page.md");
  writeFileSync(page, "# Freshness\n\nhello\n");
  return { home, origin, mine, theirs, page };
}

function advanceOrigin(theirs: string, path: string, content: string) {
  git(theirs, "pull", "--rebase", "origin", "main");
  writeFileSync(join(theirs, path), content);
  git(theirs, "add", "-A");
  git(theirs, "commit", "-m", `advance ${path}`);
  git(theirs, "push", "origin", "main");
}

// Async spawn: spawnSync would block the event loop this test's own
// server runs on, deadlocking the publish PUT against it.
async function publish(world: { home: string; mine: string; page: string }, ...extra: string[]) {
  const args = extra.length > 0 ? extra : ["--name", "fresh", "--file", world.page];
  const proc = Bun.spawn(["bun", join(repoRoot, "skills/publish-page/publish.ts"), ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: world.home,
      AGENTKIT_PAGES_REPO: world.mine,
      AGENTKIT_PAGES_ENDPOINT: `http://127.0.0.1:${server.port}`,
    },
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { status, stdout, stderr };
}

describe("publishing refuses a theme that upstream has superseded", () => {
  test("clone behind with themes/ changed upstream: refuse, name the remedy, publish nothing", async () => {
    const w = makeWorld();
    advanceOrigin(w.theirs, "themes/doc.html", bundledDoc + "\n<!-- newer canonical -->\n");
    const before = puts;
    const r = await publish(w);
    expect({ status: r.status, puts: puts - before }).toEqual({ status: 1, puts: 0 });
    // The refusal must say the CLONE is the stale side and give its remedy —
    // the old warning pointed at the bundle, whose remedy destroys good themes.
    expect(r.stderr).toMatch(/behind/);
    expect(r.stderr).toMatch(/stale/i);
    // Remedy last on its line, nothing after it: agents paste this.
    expect(r.stderr).toMatch(/run: git -C \S+ pull --rebase\s*$/m);
    // A printed remedy must WORK: run it verbatim, and the retry publishes.
    git(w.mine, "pull", "--rebase");
    const retry = await publish(w);
    expect({ status: retry.status, puts: puts - before }).toEqual({ status: 0, puts: 1 });
    expect(ahead(w.mine)).toBe("0");
  }, 20000);

  test("clone behind but themes/ untouched upstream: the page publishes", async () => {
    const w = makeWorld();
    advanceOrigin(w.theirs, "README.md", "unrelated\n");
    const before = puts;
    const r = await publish(w);
    // No refusal — the PUT goes through. The later canonical push is rejected
    // (origin advanced), which is the loud exit the second describe pins.
    expect({ puts: puts - before, refused: r.stderr.includes("stale CSS") }).toEqual({ puts: 1, refused: false });
    expect(r.stdout).toContain("/fake-slug");
  }, 20000);

  test("current clone whose theme differs from the bundle: warn that the BUNDLE lags", async () => {
    const w = makeWorld();
    writeFileSync(join(w.mine, "themes/doc.html"), bundledDoc + "\n<!-- local canonical edit -->\n");
    git(w.mine, "add", "-A");
    git(w.mine, "commit", "-m", "newer canonical theme");
    git(w.mine, "push", "origin", "main");
    const before = puts;
    const r = await publish(w);
    expect({ status: r.status, puts: puts - before }).toEqual({ status: 0, puts: 1 });
    expect(r.stderr).toMatch(/bundled theme lags/);
    expect(r.stderr).not.toMatch(/drifted from canonical/);
  }, 20000);

  test("fetch failure: say the check could not run, then publish anyway", async () => {
    const w = makeWorld();
    git(w.mine, "remote", "set-url", "origin", join(w.mine, "does-not-exist"));
    const before = puts;
    const r = await publish(w);
    // The broken remote also fails the later push, so only the PUT and the
    // warning distinguish this from a refusal.
    expect({ puts: puts - before, refused: r.stderr.includes("stale CSS") }).toEqual({ puts: 1, refused: false });
    expect(r.stderr).toMatch(/could not verify/);
    expect(r.stdout).toContain("/fake-slug");
  }, 20000);

  test("no upstream to compare (detached HEAD): say so, then publish anyway", async () => {
    const w = makeWorld();
    git(w.mine, "checkout", "--detach");
    const before = puts;
    const r = await publish(w);
    expect({ puts: puts - before, refused: r.stderr.includes("stale CSS") }).toEqual({ puts: 1, refused: false });
    expect(r.stderr).toMatch(/could not compare the pages clone against an upstream/);
  }, 20000);

  test("stranded commit then upstream theme change: refusal remedy still works on the divergent clone", async () => {
    const w = makeWorld();
    advanceOrigin(w.theirs, "README.md", "strand the first publish commit\n");
    const first = await publish(w);
    expect(first.status).toBe(1);
    advanceOrigin(w.theirs, "themes/doc.html", bundledDoc + "\n<!-- upstream css -->\n");
    const refused = await publish(w);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/stale CSS/);
    // A plain `git pull` aborts here (divergent branches) — the printed
    // --rebase form must survive exactly the state the stranded commit creates.
    git(w.mine, "pull", "--rebase");
    const retry = await publish(w);
    expect({ status: retry.status, stranded: ahead(w.mine) }).toEqual({ status: 0, stranded: "0" });
  }, 20000);

  test("ahead-only clone (local theme edit, unpushed): publishes cleanly", async () => {
    const w = makeWorld();
    writeFileSync(join(w.mine, "themes/doc.html"), bundledDoc + "\n<!-- unpushed local edit -->\n");
    git(w.mine, "add", "-A");
    git(w.mine, "commit", "-m", "local theme edit");
    const before = puts;
    const r = await publish(w);
    expect({ status: r.status, puts: puts - before }).toEqual({ status: 0, puts: 1 });
    expect(r.stderr).not.toMatch(/stale CSS/);
  }, 20000);
});

describe("a rejected canonical push fails loud", () => {
  test("non-fast-forward push: page is live, exit is 1, remedy named", async () => {
    const w = makeWorld();
    advanceOrigin(w.theirs, "README.md", "unrelated, makes mine's push non-fast-forward\n");
    const before = puts;
    const r = await publish(w);
    // The PUT succeeded and the URL printed — but the canonical history
    // silently losing the page was the defect, so the exit must be loud.
    expect({ puts: puts - before, status: r.status }).toEqual({ puts: 1, status: 1 });
    expect(r.stdout).toContain("/fake-slug");
    // No asserted cause — the failure is reported, git's error carries the why,
    // and the rejection remedy is offered as a conditional.
    expect(r.stderr).toMatch(/push failed/);
    expect(r.stderr).toMatch(/does NOT carry this publish/);
    expect(r.stderr).toMatch(/if the push was rejected.*git -C \S+ pull --rebase/);
    // The remedy must WORK: pull --rebase, re-run the same command, and the
    // stranded commit reaches canonical even though nothing new is staged.
    git(w.mine, "pull", "--rebase");
    const retry = await publish(w);
    expect({ status: retry.status, stranded: ahead(w.mine) }).toEqual({ status: 0, stranded: "0" });
  }, 20000);

  test("delete with a rejected push: loud exit, and the message describes a deletion", async () => {
    const w = makeWorld();
    const first = await publish(w);
    expect(first.status).toBe(0);
    advanceOrigin(w.theirs, "README.md", "advance, so the delete commit cannot push\n");
    const r = await publish(w, "--name", "fresh", "--delete");
    expect({ status: r.status }).toEqual({ status: 1 });
    expect(r.stdout).toContain("deleted:");
    expect(r.stderr).toMatch(/push failed/);
    expect(r.stderr).toMatch(/does NOT carry this deletion/);
    // The publish wording would be false here — the page is gone, not live.
    expect(r.stderr).not.toContain("the page itself is live");
    // Remedy works on the delete path too — against real server semantics: the
    // page is already gone, the retry's DELETE 404s, and the stranded deletion
    // commit must still reach canonical instead of dying on "nothing deleted".
    git(w.mine, "pull", "--rebase");
    const retry = await publish(w, "--name", "fresh", "--delete");
    expect({ status: retry.status, stranded: ahead(w.mine) }).toEqual({ status: 0, stranded: "0" });
    expect(retry.stdout).toContain("canonical record updated");
  }, 20000);

  test("deleting a page that never existed fails loud, even from a clone with unrelated stranded work", async () => {
    const w = makeWorld();
    const clean = await publish(w, "--name", "never-published", "--delete");
    expect(clean.status).toBe(1);
    expect(clean.stderr).toMatch(/nothing deleted/);
    // Strand an unrelated publish commit, then mistype the delete again: the
    // 404 tolerance is scoped to the deleted slug's own history, so this must
    // stay an error and must not push the unrelated commit as a side effect.
    advanceOrigin(w.theirs, "README.md", "make the publish push fail\n");
    const strand = await publish(w);
    expect(strand.status).toBe(1);
    const typo = await publish(w, "--name", "never-published", "--delete");
    expect({ status: typo.status, stillStranded: ahead(w.mine) }).toEqual({ status: 1, stillStranded: "1" });
    expect(typo.stderr).toMatch(/nothing deleted/);
  }, 20000);
});

import { afterAll, beforeAll, beforeEach } from 'bun:test';
import { execSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HEAD, REPOSITORY, SOURCE_BRANCH } from './constants';

// The gate resolves the merge target from the FORGE, so the fixture ships a
// fake `glab`/`gh` on PATH. Every bypass the 2026-07-19 review found is a case
// here — the previous suite passed with all of them present, which is how an
// overstated "the agent cannot dismiss this" claim reached review.

export let repo: string;
export let bin: string;
export let home: string;
export let forgeLog: string;
export let targetSha: string;
export let sourceSha = HEAD;
let baseTarget: string;
let githubBaseRefSha: string;
let githubMergeQueue = false;

// The forge fixture's state is module-scoped, so a test in another file sets it
// through these rather than by assigning an imported binding.
export function setTargetSha(sha: string): void {
  targetSha = sha;
}

export function setSourceSha(sha: string): void {
  sourceSha = sha;
}

export function setGithubBaseRefSha(sha: string): void {
  githubBaseRefSha = sha;
}

export function setGithubMergeQueue(enabled: boolean): void {
  githubMergeQueue = enabled;
}

/** Fake forge CLI: MR 12 -> feat/thing@HEAD, MR 999 -> other/branch. */
export function writeFakeForge(): void {
  const script = `#!/usr/bin/env bash
args="$*"
printf '%s\\t%s\\n' "\${0##*/}" "$*" >>"${forgeLog}"
if [[ "$1" == "repo" && "$2" == "view" ]]; then
  echo '{"id":"R_fixture","nameWithOwner":"owner/repo","url":"${REPOSITORY}"}'
  exit 0
fi
if [[ "$1" == "api" && "$args" == *"/repository/branches/"* ]]; then
  echo '{"commit":{"id":"${targetSha}"}}'
  exit 0
fi
if [[ "$1" == "api" && "$args" == *"/rules/branches/"* ]]; then
  echo '${githubMergeQueue ? '[[{"type":"merge_queue"}]]' : '[[]]'}'
  exit 0
fi
if [[ "$1" == "api" && "$args" == *"repos/"*"/branches/"* ]]; then
  echo '{"commit":{"sha":"${targetSha}"}}'
  exit 0
fi
if [[ "$1" == "api" && "$args" == *"/merge_requests/"*"/diffs"* ]]; then
  echo '[{"new_path":"README.md","old_path":"README.md"}]'
  exit 0
fi
if [[ "$1" == "api" && "$args" == *"/pulls/"*"/files"* ]]; then
  echo '[[{"filename":"README.md"}]]'
  exit 0
fi
id=""
for a in "$@"; do [[ "$a" =~ ^[0-9]+$ ]] && id="$a" && break; done
if [[ "$id" == "999" ]]; then
  echo '{"source_branch":"other/branch","sha":"${'b'.repeat(40)}","headRefName":"other/branch","headRefOid":"${'b'.repeat(40)}","target_branch":"main","target_project_id":1,"project_id":1,"web_url":"${REPOSITORY}/-/merge_requests/999","diff_refs":{"base_sha":"${targetSha}","head_sha":"${'b'.repeat(40)}"},"baseRefName":"main","baseRefOid":"${githubBaseRefSha}","url":"${REPOSITORY}/pull/999"}'
else
  echo '{"source_branch":"${SOURCE_BRANCH}","sha":"${sourceSha}","headRefName":"${SOURCE_BRANCH}","headRefOid":"${sourceSha}","target_branch":"main","target_project_id":1,"project_id":1,"web_url":"${REPOSITORY}/-/merge_requests/12","diff_refs":{"base_sha":"${targetSha}","head_sha":"${sourceSha}"},"baseRefName":"main","baseRefOid":"${githubBaseRefSha}","url":"${REPOSITORY}/pull/12"}'
fi
`;
  for (const name of ['glab', 'gh']) {
    const p = join(bin, name);
    writeFileSync(p, script);
    chmodSync(p, 0o755);
  }
}

export function record(body: unknown, slug = 'feat__thing'): void {
  mkdirSync(join(repo, '.agentkit', 'reviews'), { recursive: true });
  writeFileSync(join(repo, '.agentkit', 'reviews', `${slug}.json`), JSON.stringify(body));
}

function createRepo(): void {
  const root = mkdtempSync(join(tmpdir(), 'agentkit-review-'));
  repo = join(root, 'repo');
  bin = join(root, 'bin');
  home = join(root, 'home');
  forgeLog = join(root, 'forge.log');
  mkdirSync(repo);
  mkdirSync(bin);
  mkdirSync(home);
  execSync('git init -q -b main', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email agentkit-tests@example.invalid', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name "AgentKit Tests"', { cwd: repo, stdio: 'pipe' });
  execSync('git remote add origin git@github.example:owner/repo.git', {
    cwd: repo,
    stdio: 'pipe',
  });
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  execSync('git add README.md', { cwd: repo, stdio: 'pipe' });
  execSync('git commit -qm "test: base target"', { cwd: repo, stdio: 'pipe' });
  baseTarget = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim();
  targetSha = baseTarget;
  githubBaseRefSha = baseTarget;
  githubMergeQueue = false;
  sourceSha = HEAD;
  writeFakeForge();
}

function resetRepo(): void {
  rmSync(join(repo, '.agentkit'), { force: true, recursive: true });
  rmSync(join(repo, '..', 'duplicate'), { force: true, recursive: true });
  execSync('git remote set-url origin git@github.example:owner/repo.git', {
    cwd: repo,
    stdio: 'pipe',
  });
  execSync(`git reset --hard ${baseTarget}`, { cwd: repo, stdio: 'pipe' });
  targetSha = baseTarget;
  githubBaseRefSha = baseTarget;
  githubMergeQueue = false;
  sourceSha = HEAD;
  writeFileSync(forgeLog, '');
  writeFakeForge();
}

// Called once per test file: bun scopes lifecycle hooks to the file that
// registers them, so each file builds and tears down its own fixture repo.
export function installFixture(): void {
  beforeAll(createRepo);
  afterAll(() => rmSync(join(repo, '..'), { force: true, recursive: true }));
  beforeEach(resetRepo);
}

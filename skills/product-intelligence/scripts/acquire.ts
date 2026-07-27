#!/usr/bin/env bun
// Hardened acquisition wrappers: fixed argv for every tool, SSRF-checked
// targets, and a provenance stamp per record. The model never composes these
// invocations — it runs this script.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertHostAllowed, safeFetch } from './net.ts';

const DOC_GLOBS = 'README*,readme*,docs/**,doc/**,CHANGELOG*,CHANGES*,*.md';
const OWNER_REPO = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;

export function runnerPrefix(platform: string = process.platform): string[] {
  if (platform !== 'linux') return [];
  if (!Bun.which('agentkit-run', { PATH: process.env.PATH ?? '' })) {
    throw new Error(
      'agentkit-run is required on Linux so acquisition tools run resource-bounded; refusing to run them unbounded',
    );
  }
  return ['agentkit-run', '--profile', 'default', '--'];
}

export function repomixArgs(remote: string, outFile: string): string[] {
  const remoteUrl = /^https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+(\.git)?\/?$/.test(remote);
  if (!remoteUrl && !OWNER_REPO.test(remote)) {
    throw new Error(
      `refusing repomix target '${remote}': must be a remote https URL or owner/repo — `
        + 'never a local path (a repomix.config.ts inside a clone executes on load)',
    );
  }
  return ['repomix', '--remote', remote, '--style', 'json', '--include', DOC_GLOBS, '-o', outFile];
}

export function advertoolsArgs(seed: string, outFile: string): string[] {
  const url = new URL(seed);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`refusing crawl seed '${seed}': only http(s)`);
  }
  if (!outFile.endsWith('.jl') && !outFile.endsWith('.jsonl')) {
    throw new Error('advertools requires a .jl/.jsonl output file');
  }
  return [
    'advertools',
    'crawl',
    url.href,
    outFile,
    '--follow-links',
    '--custom-settings',
    'DEPTH_LIMIT=3',
    'CLOSESPIDER_PAGECOUNT=200',
  ];
}

function stamp(outDir: string, tool: string, target: string, invocation: string[]): void {
  const record = join(outDir, 'acquisition.json');
  const entries = existsSync(record) ? JSON.parse(readFileSync(record, 'utf-8')) : [];
  entries.push({ tool, target, retrieved_at: new Date().toISOString().slice(0, 10) });
  writeFileSync(record, `${JSON.stringify(entries, null, 2)}\n`);
  appendFileSync(
    join(outDir, 'invocations.log'),
    `${JSON.stringify({ at: new Date().toISOString(), invocation })}\n`,
  );
}

function run(argv: string[], stdin?: Uint8Array): void {
  const result = Bun.spawnSync(argv, { stdin, stdout: 'inherit', stderr: 'inherit' });
  if (result.exitCode !== 0) throw new Error(`${argv[0]} exited ${result.exitCode}`);
}

async function acquireUrl(target: string, outDir: string): Promise<void> {
  const fetched = await safeFetch(target);
  const slug = new URL(fetched.finalUrl).pathname.replace(/[^\w.-]+/g, '_') || '_root';
  writeFileSync(join(outDir, `page${slug}.html`), fetched.body);
  stamp(outDir, 'safe-fetch', target, ['safe-fetch', target]);
  if (!Bun.which('trafilatura')) {
    console.error('note: trafilatura not on PATH — raw page saved, no content extraction');
    return;
  }
  const argv = [...runnerPrefix(), 'trafilatura', '--json'];
  const result = Bun.spawnSync(argv, { stdin: fetched.body, stdout: 'pipe', stderr: 'inherit' });
  if (result.exitCode !== 0) throw new Error(`trafilatura exited ${result.exitCode}`);
  writeFileSync(join(outDir, `content${slug}.json`), result.stdout);
  stamp(outDir, 'trafilatura', fetched.finalUrl, argv);
}

async function acquireSite(target: string, outDir: string): Promise<void> {
  await assertHostAllowed(new URL(target).hostname);
  const argv = [...runnerPrefix(), ...advertoolsArgs(target, join(outDir, 'crawl.jl'))];
  run(argv);
  stamp(outDir, 'advertools', target, argv);
}

function acquireRepo(target: string, outDir: string): void {
  const argv = [...runnerPrefix(), ...repomixArgs(target, join(outDir, 'repo.json'))];
  run(argv);
  stamp(outDir, 'repomix --remote', target, argv);
}

function acquireGh(target: string, outDir: string): void {
  if (!OWNER_REPO.test(target)) throw new Error(`refusing gh target '${target}': expected owner/repo`);
  const lanes: [string, string[]][] = [
    ['gh-meta.json', ['gh', 'api', `repos/${target}`]],
    ['gh-releases.json', ['gh', 'api', `repos/${target}/releases?per_page=20`]],
    ['gh-readme.md', ['gh', 'api', `repos/${target}/readme`, '-H', 'Accept: application/vnd.github.raw']],
  ];
  for (const [file, argv] of lanes) {
    const result = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'inherit' });
    if (result.exitCode !== 0) throw new Error(`${argv.join(' ')} exited ${result.exitCode}`);
    writeFileSync(join(outDir, file), result.stdout);
  }
  stamp(outDir, 'gh api', target, ['gh', 'api', `repos/${target}`, '...']);
}

if (import.meta.main) {
  const [cmd, target, outFlag, outDir] = process.argv.slice(2);
  if (!cmd || !target || outFlag !== '--out' || !outDir) {
    console.error('usage: acquire.ts <url|site|repo|gh> <target> --out <dir>');
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });
  const lanes: Record<string, (t: string, o: string) => void | Promise<void>> = {
    url: acquireUrl,
    site: acquireSite,
    repo: acquireRepo,
    gh: acquireGh,
  };
  const lane = lanes[cmd];
  if (!lane) {
    console.error(`unknown lane '${cmd}' — expected url, site, repo or gh`);
    process.exit(2);
  }
  try {
    await lane(target, outDir);
    console.log(`ok: ${cmd} ${target} -> ${outDir}`);
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    process.exit(1);
  }
}

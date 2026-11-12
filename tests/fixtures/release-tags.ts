import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// A release commit carries vX.Y.Z and, a moment later, hugo/diagrams/vX.Y.Z.
// git describe prefers the newer annotated tag, so the module tag wins unless
// the resolver restricts itself to release tags.
export function releaseTaggedRepo(version: string, commitsPastTag = 0): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentkit-release-tags-'));
  const git = (args: string[], date: string) => {
    const r = spawnSync('git', ['-C', dir, ...args], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  git(['init', '-q'], '2026-01-01T00:00:00Z');
  git(['commit', '-q', '--allow-empty', '-m', 'release'], '2026-01-01T00:00:00Z');
  git(['tag', '-a', version, '-m', version], '2026-01-01T00:00:00Z');
  git(['tag', '-a', `hugo/diagrams/${version}`, '-m', 'module'], '2026-01-02T00:00:00Z');
  for (let i = 0; i < commitsPastTag; i += 1) {
    git(['commit', '-q', '--allow-empty', '-m', `after ${i}`], '2026-01-03T00:00:00Z');
  }
  return dir;
}

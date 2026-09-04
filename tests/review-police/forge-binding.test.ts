import { describe, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { passing } from './commands';
import { HEAD } from './constants';
import { forgeLog, installFixture, record } from './fixture';
import { runHook, test } from './probe';

installFixture();

describe('review-police: forge host binding', () => {
  test('pins GitHub target APIs to the host resolved from the target repository', () => {
    record(passing);
    expect(
      runHook(`gh pr merge 12 --repo github.example/owner/repo --match-head-commit ${HEAD}`),
    ).toBe('');

    expect(readFileSync(forgeLog, 'utf-8')).toContain(
      'gh\tapi --hostname github.example repos/owner/repo/branches/main',
    );
  });

  test('pins GitLab target APIs to the host resolved from the merge request', () => {
    record(passing);
    expect(
      runHook(
        `glab mr merge 12 --repo github.example/owner/repo --sha ${HEAD} --auto-merge=false`,
      ),
    ).toBe('');

    expect(readFileSync(forgeLog, 'utf-8')).toContain(
      'glab\tapi --hostname github.example projects/1/repository/branches/main',
    );
  });
});

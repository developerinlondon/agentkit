import { HEAD } from './constants';

export const passing = { head_sha: HEAD, verdict: 'pass', findings: [] };
export const MERGE = `glab mr merge 12 --squash --yes --sha ${HEAD} --auto-merge=false`;
export const MERGE_WITH_REPO = `${MERGE} --repo owner/repo`;
export const GITHUB_MERGE_WITH_REPO =
  `gh pr merge 12 --squash --delete-branch --match-head-commit ${HEAD} --repo owner/repo`;

export function mergeForHead(head: string): string {
  return `glab mr merge 12 --squash --yes --sha ${head} --auto-merge=false`;
}

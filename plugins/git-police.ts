import type { PluginInput } from '@opencode-ai/plugin';
import { spawnSync } from 'node:child_process';

const PROTECTED_BRANCHES = ['main', 'master'];

function getCurrentBranch(cwd: string): string | null {
  const result = spawnSync('git', ['branch', '--show-current'], {
    cwd,
    timeout: 5000,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout.trim();
}

function isGitCommitCommand(command: string): boolean {
  return /\bgit\b.*\bcommit\b/i.test(command);
}

function isGitPushToProtected(command: string): boolean {
  if (!/\bgit\b.*\bpush\b/i.test(command)) return false;

  for (const branch of PROTECTED_BRANCHES) {
    if (new RegExp(`\\bpush\\b.*\\b${branch}\\b`, 'i').test(command)) return true;
  }
  return false;
}

function isForcePush(command: string): boolean {
  return /\bgit\b.*\bpush\b.*(-f|--force|--force-with-lease)\b/i.test(command);
}

function isGitCheckoutProtected(command: string): boolean {
  if (!/\bgit\b.*\b(checkout|switch)\b/i.test(command)) return false;
  if (/\b-b\b/.test(command)) return false;

  for (const branch of PROTECTED_BRANCHES) {
    if (new RegExp(`\\b(checkout|switch)\\b\\s+${branch}\\b`, 'i').test(command)) return true;
  }
  return false;
}

export default async function gitPolice(ctx: PluginInput) {
  return {
    'tool.execute.before': async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> },
    ): Promise<void> => {
      const toolName = input.tool?.toLowerCase();
      if (toolName !== 'bash') return;

      const command = output.args.command as string | undefined;
      if (!command) return;

      if (/\bgit\b.*--no-verify\b/i.test(command)) {
        throw new Error(
          `BLOCKED: --no-verify is forbidden.\n` +
            `Skipping pre-commit hooks bypasses quality gates (linting, tests, formatting).\n` +
            `Fix the issue that's causing the hook to fail instead.`,
        );
      }

      if (isForcePush(command)) {
        throw new Error(
          `BLOCKED: Force push is forbidden.\n` +
            `Force pushing rewrites history and can destroy work.\n` +
            `If you truly need this, ask the user for explicit approval first.`,
        );
      }

      if (isGitPushToProtected(command)) {
        throw new Error(
          `BLOCKED: Pushing directly to a protected branch (${PROTECTED_BRANCHES.join('/')}) is forbidden.\n` +
            `Create a feature branch and raise a PR instead.`,
        );
      }

      if (/\bgit\b.*\bpush\b/i.test(command) && !isGitPushToProtected(command)) {
        const branch = getCurrentBranch(ctx.directory);
        if (branch && PROTECTED_BRANCHES.includes(branch)) {
          throw new Error(
            `BLOCKED: You are on '${branch}'. Pushing from a protected branch is forbidden.\n` +
              `Create a feature branch first:\n` +
              `  git checkout -b feat/your-feature-name\n` +
              `Then push from there and raise a PR.`,
          );
        }
      }

      if (isGitCheckoutProtected(command)) {
        return;
      }

      if (isGitCommitCommand(command)) {
        const branch = getCurrentBranch(ctx.directory);
        if (branch && PROTECTED_BRANCHES.includes(branch)) {
          throw new Error(
            `BLOCKED: Committing directly to '${branch}' is forbidden.\n` +
              `You are on the ${branch} branch. Create a feature branch first:\n` +
              `  git checkout -b feat/your-feature-name\n` +
              `Then commit your changes there and raise a PR.`,
          );
        }

        if (/co-authored-by/i.test(command)) {
          throw new Error(
            `BLOCKED: AI attribution trailers (Co-authored-by) are forbidden in commit messages.\n` +
              `Do not add Co-authored-by, Signed-off-by, or other AI agent attribution lines.\n` +
              `The commit author is whoever owns the git config. Remove the trailer and retry.`,
          );
        }
      }
    },
  };
}

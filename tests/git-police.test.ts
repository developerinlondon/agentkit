import { describe, test, expect, mock } from 'bun:test';
import gitPolice from '../plugins/git-police';

const mockCtx = { client: {}, project: {}, directory: '/tmp', worktree: '/tmp', serverUrl: new URL('http://localhost'), $: {} } as any;

function makeInput(command: string) {
  return {
    input: { tool: 'bash', sessionID: 'test', callID: 'test' },
    output: { args: { command } },
  };
}

describe('git-police', () => {
  describe('blocks --no-verify', () => {
    const commands = [
      'git commit --no-verify -m "skip hooks"',
      'git push --no-verify',
      'git commit -m "fix" --no-verify',
    ];

    for (const cmd of commands) {
      test(`blocks: ${cmd}`, async () => {
        const hooks = await gitPolice(mockCtx);
        const { input, output } = makeInput(cmd);
        expect(hooks['tool.execute.before']!(input, output)).rejects.toThrow('--no-verify');
      });
    }
  });

  describe('blocks force push', () => {
    const commands = [
      'git push --force origin feat/x',
      'git push -f origin feat/x',
      'git push --force-with-lease origin feat/x',
    ];

    for (const cmd of commands) {
      test(`blocks: ${cmd}`, async () => {
        const hooks = await gitPolice(mockCtx);
        const { input, output } = makeInput(cmd);
        expect(hooks['tool.execute.before']!(input, output)).rejects.toThrow('Force push');
      });
    }
  });

  describe('blocks push to protected branches', () => {
    const commands = [
      'git push origin main',
      'git push origin master',
    ];

    for (const cmd of commands) {
      test(`blocks: ${cmd}`, async () => {
        const hooks = await gitPolice(mockCtx);
        const { input, output } = makeInput(cmd);
        expect(hooks['tool.execute.before']!(input, output)).rejects.toThrow('protected branch');
      });
    }
  });

  describe('blocks AI attribution trailers in commits', () => {
    const commands = [
      'git commit -m "fix stuff\n\nCo-authored-by: Claude <claude@anthropic.com>"',
      'git commit -m "fix\n\nCo-Authored-By: GPT"',
    ];

    for (const cmd of commands) {
      test(`blocks: ${cmd.substring(0, 60)}`, async () => {
        const hooks = await gitPolice(mockCtx);
        const { input, output } = makeInput(cmd);
        expect(hooks['tool.execute.before']!(input, output)).rejects.toThrow('attribution');
      });
    }
  });

  describe('allows safe git operations', () => {
    const commands = [
      'git status',
      'git diff',
      'git log --oneline -10',
      'git push origin feat/my-branch',
      'git push -u origin feat/safety-plugins',
      'git checkout main',
      'git checkout -b feat/new-feature',
      'git switch main',
      'git branch -a',
      'git fetch origin',
      'git pull origin dev',
      'git stash',
      'git merge feat/x',
    ];

    for (const cmd of commands) {
      test(`allows: ${cmd}`, async () => {
        const hooks = await gitPolice(mockCtx);
        const { input, output } = makeInput(cmd);
        expect(hooks['tool.execute.before']!(input, output)).resolves.toBeUndefined();
      });
    }
  });

  test('ignores non-bash tools', async () => {
    const hooks = await gitPolice(mockCtx);
    const input = { tool: 'edit', sessionID: 'test', callID: 'test' };
    const output = { args: { command: 'git push --force origin main' } };
    expect(hooks['tool.execute.before']!(input, output)).resolves.toBeUndefined();
  });
});

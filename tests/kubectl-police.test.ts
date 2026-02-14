import { describe, test, expect } from 'bun:test';
import kubectlPolice from '../plugins/kubectl-police';

const mockCtx = { client: {}, project: {}, directory: '/tmp', worktree: '/tmp', serverUrl: new URL('http://localhost'), $: {} } as any;

function makeInput(command: string) {
  return {
    input: { tool: 'bash', sessionID: 'test', callID: 'test' },
    output: { args: { command } },
  };
}

describe('kubectl-police', () => {
  describe('blocks kubectl create/apply for Kargo CRDs', () => {
    const blockedCommands = [
      'kubectl create -f promotion.yaml',
      'kubectl apply -f promotion.yaml',
      'kubectl create promotion test -n kargo',
      'kubectl apply -f - <<EOF\nkind: Promotion\nEOF',
      'kubectl create stage foo -n kargo',
      'kubectl apply -f stage.yaml',
      'kubectl create freight bar',
      'kubectl create warehouse baz',
      'MISE_ENV=dev mise run server:ssh "kubectl create promotion test"',
      'MISE_ENV=dev mise run server:ssh "kubectl apply -f stages.yaml"',
    ];

    for (const cmd of blockedCommands) {
      test(`blocks: ${cmd.substring(0, 70)}`, async () => {
        const hooks = await kubectlPolice(mockCtx);
        const { input, output } = makeInput(cmd);
        expect(hooks['tool.execute.before']!(input, output)).rejects.toThrow('BLOCKED');
      });
    }
  });

  describe('allows safe kubectl commands', () => {
    const allowedCommands = [
      'kubectl get promotions -n kargo',
      'kubectl describe promotion test -n kargo',
      'kubectl delete promotion test -n kargo',
      'kubectl delete stage foo -n kargo',
      'kubectl logs deploy/kargo-api -n infra',
      'kubectl rollout restart deploy/kargo-api',
      'kubectl get pods -A',
      'kubectl patch deploy foo -n bar',
      'kubectl label node foo env=test',
    ];

    for (const cmd of allowedCommands) {
      test(`allows: ${cmd.substring(0, 70)}`, async () => {
        const hooks = await kubectlPolice(mockCtx);
        const { input, output } = makeInput(cmd);
        expect(hooks['tool.execute.before']!(input, output)).resolves.toBeUndefined();
      });
    }
  });

  test('ignores non-bash tools', async () => {
    const hooks = await kubectlPolice(mockCtx);
    const input = { tool: 'edit', sessionID: 'test', callID: 'test' };
    const output = { args: { command: 'kubectl create promotion foo' } };
    expect(hooks['tool.execute.before']!(input, output)).resolves.toBeUndefined();
  });
});

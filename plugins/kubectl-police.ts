import type { PluginInput } from '@opencode-ai/plugin';

const KARGO_CRDS = [
  'promotion',
  'promotions',
  'stage',
  'stages',
  'freight',
  'freights',
  'warehouse',
  'warehouses',
];

const KARGO_CRD_PATTERN = new RegExp(`\\b(${KARGO_CRDS.join('|')})\\b`, 'i');

const KUBECTL_MUTATE_PATTERN = /\bkubectl\b.*\b(create|apply)\b/i;

function detectDangerousKubectl(command: string): string | null {
  if (!KUBECTL_MUTATE_PATTERN.test(command)) return null;
  if (!KARGO_CRD_PATTERN.test(command)) return null;

  const crdMatch = command.match(KARGO_CRD_PATTERN);
  const crd = crdMatch ? crdMatch[1].toLowerCase() : 'unknown';

  return (
    `BLOCKED: Creating/applying Kargo ${crd} via kubectl is forbidden.\n` +
    `kubectl-created Kargo resources poison the stage state machine:\n` +
    `  - Promotions: custom names break lexicographic sorting, currentPromotion not set\n` +
    `  - Stages: orphaned state that ArgoCD can't reconcile\n` +
    `\n` +
    `Use instead:\n` +
    `  - Kargo UI or auto-promotion for promotions\n` +
    `  - GitOps (git push) for stage/warehouse/freight changes\n` +
    `  - kubectl DELETE (not create) to recover from corrupted state`
  );
}

export default async function kubectlPolice(_ctx: PluginInput) {
  return {
    'tool.execute.before': async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> },
    ): Promise<void> => {
      const toolName = input.tool?.toLowerCase();
      if (toolName !== 'bash') return;

      const command = output.args.command as string | undefined;
      if (!command) return;

      const error = detectDangerousKubectl(command);
      if (error) {
        throw new Error(error);
      }
    },
  };
}

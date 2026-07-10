import type { PluginInput } from '@opencode-ai/plugin';

interface Launch {
  token: string;
  executable: string;
  args: string[];
}

interface Finding {
  segment: string;
  delegated: boolean;
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let segment = '';
  let quote = '';
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    const next = command[index + 1] ?? '';
    if (escaped) {
      segment += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      segment += character;
      escaped = true;
      continue;
    }
    if ((character === "'" || character === '"') && (!quote || quote === character)) {
      quote = quote ? '' : character;
      segment += character;
      continue;
    }
    const pair = `${character}${next}`;
    const separator = !quote && (
      character === ';' || character === '\n' || character === '|' || character === '&'
      || character === '(' || character === ')' || character === '{' || character === '}'
      || pair === '&&'
    );
    if (separator) {
      if (segment.trim()) segments.push(segment.trim());
      segment = '';
      if (pair === '&&' || pair === '||') index += 1;
      continue;
    }
    segment += character;
  }
  if (segment.trim()) segments.push(segment.trim());
  return segments;
}

function basename(command: string): string {
  return command.replace(/['"(){}]/g, '').split('/').pop() ?? '';
}

function parseLaunch(segment: string): Launch | null {
  const tokens = segment.trim().split(/\s+/);
  let index = 0;
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
  while (tokens[index]) {
    while (assignment.test(tokens[index] ?? '')) index += 1;
    const wrapper = basename(tokens[index] ?? '').toLowerCase();
    if (/^(doas|pkexec|run0|sudo)$/.test(wrapper)) {
      return { token: tokens[index], executable: wrapper, args: tokens.slice(index + 1) };
    }
    if (wrapper === 'env') {
      index += 1;
      while ((tokens[index] ?? '').startsWith('-') || assignment.test(tokens[index] ?? '')) {
        index += 1;
      }
      continue;
    }
    if (/^(command|nohup|time)$/.test(wrapper)) {
      index += 1;
      while ((tokens[index] ?? '').startsWith('-')) index += 1;
      continue;
    }
    break;
  }
  if (!tokens[index]) return null;
  return { token: tokens[index], executable: basename(tokens[index]), args: tokens.slice(index + 1) };
}

function isHeavy(launch: Launch): boolean {
  const [first = '', second = ''] = launch.args;
  switch (launch.executable.toLowerCase()) {
    case 'bun':
      if (/^(add|install|update|test)$/i.test(first)) return true;
      return first === 'run' && /^(build|check|type-?check|lint|test)(?::[\w-]+)?$/i.test(second);
    case 'bunx':
      if (first === 'tsc') return second !== '--version';
      return first === 'playwright' && second === 'test';
    case 'tsc':
      return first !== '--version';
    case 'playwright':
      return first === 'test';
    case 'cargo':
      return /^(build|check|test|clippy)$/i.test(first);
    case 'go':
      return /^(build|test)$/i.test(first);
    case 'docker':
    case 'podman':
      return false;
    case 'pytest':
      return true;
    case 'python':
    case 'python3':
      return first === '-m' && second === 'pytest';
    default:
      return false;
  }
}

function isDelegating(launch: Launch): boolean {
  const effective = unwrapEnvironment(launch);
  if (/^(ansible|ansible-playbook|doas|mosh|pkexec|run0|ssh|sudo|systemd-run)$/i.test(effective.executable)) {
    return true;
  }
  if (/^(buildah|docker|machinectl|nerdctl|podman|service|systemctl|kubectl)$/i.test(effective.executable)) {
    return !isReadOnlyDiagnostic(effective);
  }
  return /^(bash|sh|zsh)$/i.test(effective.executable)
    && effective.args.some((argument) => argument === '-c' || argument === '-lc');
}

function isReadOnlyDiagnostic(launch: Launch): boolean {
  const [first = '', second = ''] = launch.args;
  switch (launch.executable.toLowerCase()) {
    case 'systemctl':
      return /^(cat|get-default|is-active|is-enabled|is-failed|list-|show|status)/.test(first);
    case 'kubectl':
      return /^(api-resources|api-versions|auth|cluster-info|describe|explain|get|logs|top|version)$/.test(first);
    case 'docker':
    case 'nerdctl':
    case 'podman':
      return /^(diff|events|history|images|info|inspect|logs|port|ps|stats|top|version)$/.test(first);
    case 'buildah':
      return /^(containers|images|info|inspect|version)$/.test(first);
    case 'machinectl':
      return /^(list|show|status)$/.test(first);
    case 'service':
      return second === 'status';
    default:
      return false;
  }
}

function unwrapEnvironment(launch: Launch): Launch {
  if (launch.executable !== 'env') return launch;
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
  let index = 0;
  while ((launch.args[index] ?? '').startsWith('-') || assignment.test(launch.args[index] ?? '')) {
    index += 1;
  }
  if (!launch.args[index]) return launch;
  return {
    token: launch.args[index],
    executable: basename(launch.args[index]),
    args: launch.args.slice(index + 1),
  };
}

function wrappedLaunch(launch: Launch): Launch | null {
  const separator = launch.args.indexOf('--');
  if (separator < 0 || !launch.args[separator + 1]) return null;
  return {
    token: launch.args[separator + 1],
    executable: basename(launch.args[separator + 1]),
    args: launch.args.slice(separator + 2),
  };
}

function detectUnboundedCommand(command: string): Finding | null {
  for (const segment of splitShellSegments(command)) {
    const launch = parseLaunch(segment);
    if (!launch) continue;
    if (launch.executable === 'agentkit-run') {
      if (!isTrustedRunner(launch.token)) return { segment, delegated: true };
      const nested = wrappedLaunch(launch);
      if (nested && isDelegating(nested)) return { segment, delegated: true };
      continue;
    }
    if (isDelegating(launch)) return { segment, delegated: true };
    if (isHeavy(launch)) return { segment, delegated: false };
  }
  return null;
}

function isTrustedRunner(token: string): boolean {
  const normalized = token.replace(/['"]/g, '');
  return normalized === 'agentkit-run'
    || normalized === '$HOME/.local/bin/agentkit-run'
    || normalized === '~/.local/bin/agentkit-run'
    || normalized === './.claude/tools/agentkit-run'
    || /^\/home\/[^/]+\/\.local\/bin\/agentkit-run$/.test(normalized)
    || /\/plugins\/.*\/tools\/agentkit-run$/.test(normalized);
}

export default async function resourcePolice(_ctx: PluginInput) {
  return {
    'tool.execute.before': async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> },
    ): Promise<void> => {
      if (input.tool?.toLowerCase() !== 'bash') return;
      const command = output.args.command as string | undefined;
      if (!command) return;
      const finding = detectUnboundedCommand(command);
      if (!finding) return;
      if (finding.delegated) {
        throw new Error(
          `BLOCKED: delegated workload cannot be contained by agentkit-run: ${finding.segment}\n` +
            'Use a separately approved dedicated runner or verified engine-native limits.',
        );
      }
      throw new Error(
        `BLOCKED: resource-intensive command is not contained: ${finding.segment}\n` +
          'Run it through the installed runner, for example:\n' +
          '  agentkit-run --profile compile -- bun run typecheck\n' +
          '  ./.claude/tools/agentkit-run --profile compile -- bun run typecheck\n' +
          'Use profile browser for Playwright and browser builds.',
      );
    },
  };
}

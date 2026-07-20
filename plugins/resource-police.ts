import type { PluginInput } from '@opencode-ai/plugin';

interface Launch {
  token: string;
  executable: string;
  args: string[];
}

interface Finding {
  segment: string;
  delegated: boolean;
  /** The runner is not the INSTALLED bounded-run. Distinct from `delegated`:
   *  the delegated message advertises an escape hatch that cannot clear this. */
  untrustedRunner?: boolean;
  /** Analysis gave up before reaching the real command. Must never be treated
   *  as "nothing found" — a stand-down would turn it into permission. */
  undecidable?: boolean;
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

const RUN_SCRIPT_PATTERN = /^(build|check|type-?check|lint|test)(?::[\w-]+)?$/i;

function isHeavy(launch: Launch): boolean {
  const [first = '', second = ''] = launch.args;
  switch (launch.executable.toLowerCase()) {
    case 'bun':
      if (/^(add|install|update|test)$/i.test(first)) return true;
      return first === 'run' && RUN_SCRIPT_PATTERN.test(second);
    case 'bunx':
    case 'npx':
      if (first === 'tsc') return second !== '--version';
      return first === 'playwright' && second === 'test';
    case 'npm':
    case 'pnpm':
      if (/^(add|install|i|ci|update|upgrade|test)$/i.test(first)) return true;
      return first === 'run' && RUN_SCRIPT_PATTERN.test(second);
    case 'yarn':
      if (!first) return true;
      if (/^(add|install|up|upgrade|test)$/i.test(first)) return true;
      if (first === 'run' && RUN_SCRIPT_PATTERN.test(second)) return true;
      return /^(build|check|type-?check|lint)(?::[\w-]+)?$/i.test(first);
    case 'tsc':
      return first !== '--version';
    case 'playwright':
      return first === 'test';
    case 'cargo':
      return /^(build|check|test|clippy)$/i.test(first);
    case 'go':
      return /^(build|test)$/i.test(first);
    case 'pip':
    case 'pip3':
      return first === 'install';
    case 'uv':
      if (/^(add|sync)$/i.test(first)) return true;
      if (first === 'pip' && second === 'install') return true;
      return first === 'run' && second === 'pytest';
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

function shellCommandPayload(launch: Launch): string | null {
  for (let index = 0; index < launch.args.length; index += 1) {
    const argument = launch.args[index];
    let rest: string[] | null = null;
    if (argument.startsWith('--command=')) {
      rest = [argument.slice('--command='.length), ...launch.args.slice(index + 1)];
    } else if (
      argument === '--command'
      || (!argument.startsWith('--') && /^-\S*c/.test(argument))
    ) {
      rest = launch.args.slice(index + 1);
    }
    if (rest) return rest.join(' ').replace(/['"]/g, '');
  }
  return null;
}

function isShell(executable: string): boolean {
  return /^(bash|dash|fish|sh|zsh)$/i.test(executable);
}

function isDelegating(launch: Launch): boolean {
  const effective = unwrapEnvironment(launch);
  if (/^(ansible|ansible-playbook|doas|mosh|pkexec|run0|ssh|sudo|systemd-run)$/i.test(effective.executable)) {
    return true;
  }
  if (/^(buildah|docker|machinectl|nerdctl|podman|service|systemctl|kubectl)$/i.test(effective.executable)) {
    return !isReadOnlyDiagnostic(effective);
  }
  return isShell(effective.executable) && shellCommandPayload(effective) !== null;
}

function isReadOnlyDiagnostic(launch: Launch): boolean {
  const positional = launch.args.filter((argument) => !argument.startsWith('-'));
  const [first = '', second = ''] = positional;
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
  // Route the payload through parseLaunch rather than reading the token after
  // `--` directly: that skipped every wrapper normalisation the top-level path
  // does, so `-- nohup ssh host rm` read as a launch of `nohup` and the remote
  // command behind it was never seen.
  return parseLaunch(launch.args.slice(separator + 1).join(' '));
}

// agentkit-run is the pre-rename compat alias, so both names are runner layers.
function isRunnerExecutable(executable: string): boolean {
  return executable === 'bounded-run' || executable === 'agentkit-run';
}

function detectUnboundedCommand(
  command: string,
  depth = 0,
  delegatedOk = false,
): Finding | null {
  if (depth > 3) return { segment: command, delegated: false, undecidable: true };
  for (const segment of splitShellSegments(command)) {
    const launch = parseLaunch(segment);
    if (!launch) continue;
    if (isRunnerExecutable(launch.executable)) {
      // NOT `delegated`: that message advertises AGENTKIT_ALLOW_DELEGATED=1,
      // which this path never consults, so it sent people chasing an escape
      // hatch that cannot clear it.
      // Delegation first, trust second: reporting an untrusted runner without
      // looking at its payload let a wrapper hide a delegated command. Unwrap
      // every runner layer, not one — a runner wrapping a runner buried the
      // payload one level deeper than a single check could see.
      let nested = wrappedLaunch(launch);
      while (nested && isRunnerExecutable(nested.executable)) {
        nested = wrappedLaunch(nested);
      }
      if (nested && !delegatedOk && isDelegating(nested)) return { segment, delegated: true };
      if (!isTrustedRunner(launch.token)) return { segment, delegated: false, untrustedRunner: true };
      continue;
    }
    if (isShell(launch.executable)) {
      const payload = shellCommandPayload(launch);
      if (payload !== null) {
        const finding = detectUnboundedCommand(payload, depth + 1, delegatedOk);
        if (finding) return finding;
        continue;
      }
    }
    if (!delegatedOk && isDelegating(launch)) return { segment, delegated: true };
    if (isHeavy(launch)) return { segment, delegated: false };
  }
  return null;
}

function isDelegatedOverride(command: string): boolean {
  return process.env.AGENTKIT_ALLOW_DELEGATED === '1'
    || /(^|[\s;&|])AGENTKIT_ALLOW_DELEGATED=1([\s;&|]|$)/.test(command);
}

function isTrustedRunner(token: string): boolean {
  // agentkit-run is the pre-rename compat alias installed as a symlink.
  const normalized = token.replace(/['"]/g, '').replace(/agentkit-run$/, 'bounded-run');
  return normalized === 'bounded-run'
    || normalized === '$HOME/.local/bin/bounded-run'
    || normalized === '~/.local/bin/bounded-run'
    || normalized === './.claude/tools/bounded-run'
    || /^\/home\/[^/]+\/\.local\/bin\/bounded-run$/.test(normalized)
    || /\/plugins\/.*\/tools\/bounded-run$/.test(normalized);
}

// bounded-run drives systemd-run and cgroup v2, so containment simply does not
// exist off Linux. Blocking there would order the agent to install a runner the
// installer deliberately refuses to install — a loop with no way out — so allow
// the command and say plainly that nothing is bounding it.
export function containmentAvailable(platform: string = process.platform): boolean {
  return platform === 'linux';
}

let announcedUnbounded = false;

// Exported so the policy can be driven at a chosen platform. Asserting this
// through the plugin alone can only ever exercise the host's own platform, and
// a test that cannot reach the off-Linux branch cannot guard it.
export function enforceResourcePolicy(
  command: string,
  platform: string = process.platform,
): void {
  const finding = detectUnboundedCommand(command, 0, isDelegatedOverride(command));
  if (!finding) return;
  if (finding.delegated) {
    throw new Error(
      `BLOCKED: delegated workload cannot be contained by bounded-run: ${finding.segment}\n` +
        'Use a separately approved dedicated runner or verified engine-native limits.\n' +
        'User-approved delegated workloads: prefix with AGENTKIT_ALLOW_DELEGATED=1.',
    );
  }
  // Fails closed on every platform: the analyser stopped before it could tell
  // whether this delegates, and standing down on "I do not know" is how a
  // deeply nested command walks straight through.
  if (finding.undecidable) {
    throw new Error(
      `BLOCKED: command nests too deeply to analyse: ${finding.segment}\n`
        + 'Run the inner command on its own, so what it does can be seen.',
    );
  }
  // Only the containment requirement stands down. Delegation is checked above
  // and inside the runner branch, so wrapping cannot launder it past here.
  if (!containmentAvailable(platform)) {
    if (!announcedUnbounded) {
      announcedUnbounded = true;
      console.warn(
        `[resource-police] ${platform} has no cgroup containment; `
          + 'heavy commands run unbounded and bounded-run is not installed here.',
      );
    }
    return;
  }
  if (finding.untrustedRunner) {
    throw new Error(
      `BLOCKED: that is not a recognised bounded-run: ${finding.segment}\n`
        + 'Anything can be named `bounded-run`, so it is trusted by INSTALLED PATH,\n'
        + 'not by name — otherwise a spoof could silently neuter every limit.\n'
        + 'AGENTKIT_ALLOW_DELEGATED=1 does NOT clear this. Install the runner\n'
        + '(~/.local/bin/bounded-run) and invoke it from there, or use the\n'
        + "plugin's copy under the plugin root.",
    );
  }
  throw new Error(
    `BLOCKED: resource-intensive command is not contained: ${finding.segment}\n` +
      'Run it through the installed runner, for example:\n' +
      '  bounded-run --profile compile -- bun run typecheck\n' +
      '  ./.claude/tools/bounded-run --profile compile -- bun run typecheck\n' +
      'Use profile browser for Playwright and browser builds.',
  );
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
      enforceResourcePolicy(command);
    },
  };
}

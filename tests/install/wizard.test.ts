import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(dirname(import.meta.dir));
const installScript = join(repoRoot, 'install.sh');
const globalInstallTimeoutMs = 60_000;
// The one string a scripted run must never contain. Every non-TTY assertion
// greps the whole transcript for it, so it has to be the literal the installer
// prints rather than a paraphrase of it.
const promptMarker = '? [y/N]';
// A blocked wizard is not slow, it is stopped. A bare install takes about a
// second, so a run still alive after this was waiting for a keystroke.
const hangTimeoutMs = 20_000;

// The gate names the environment that suppresses the wizard, and this reads
// that same declaration rather than keeping a second copy: the two drifting
// apart is what broke CI, where the runner exports CI=true into the suite and
// silently turned every interactive assertion into an unattended install.
// Missing means renamed, and a scrub that quietly covers nothing is worse than
// no scrub, so it throws rather than returning an empty list.
function promptSuppressingEnv(): string[] {
  const declaration = /^PROMPT_SUPPRESSING_ENV="([^"]*)"$/m.exec(
    readFileSync(installScript, 'utf-8'),
  );
  if (!declaration) {
    throw new Error('install.sh no longer declares PROMPT_SUPPRESSING_ENV');
  }
  return declaration[1].split(/\s+/).filter(Boolean);
}

function installEnv(home: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    AGENTKIT_PLATFORM: 'linux',
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    AGENTKIT_HOME: join(home, '.agentkit'),
    CODEX_HOME: join(home, '.codex'),
  };
  // Inherited suppression would also make the tests that assert *no* prompt
  // pass for the wrong reason — proving the runner's environment rather than
  // the descriptor, flag or persistence gate each of them exists to pin.
  for (const name of promptSuppressingEnv()) {
    delete env[name];
  }
  return env;
}

const baseArgs = ['--global', '--no-session-scope'];

function install(home: string, extraArgs: string[] = []) {
  return spawnSync('bash', [installScript, ...baseArgs, ...extraArgs], {
    cwd: repoRoot,
    env: installEnv(home),
    encoding: 'utf-8',
    timeout: globalInstallTimeoutMs,
  });
}

// util-linux `script` takes the command via -c with the transcript file last;
// BSD `script`, which macOS ships, has no -c at all and takes the command as
// trailing positional arguments. Probe the invocation rather than reading
// uname: what decides the syntax is which binary is on PATH, not which kernel
// is under it, and either flavour can be installed on either system.
type ScriptFlavour = 'util-linux' | 'bsd';
let scriptFlavourCache: ScriptFlavour | undefined;

function scriptFlavour(): ScriptFlavour {
  if (!scriptFlavourCache) {
    const probe = spawnSync('script', ['-qec', 'true', '/dev/null'], { encoding: 'utf-8' });
    scriptFlavourCache = probe.status === 0 ? 'util-linux' : 'bsd';
  }
  return scriptFlavourCache;
}

function scriptArgv(command: string, flavour: ScriptFlavour = scriptFlavour()): string[] {
  return flavour === 'util-linux'
    ? ['-qec', command, '/dev/null']
    : ['-q', '/dev/null', 'bash', '-c', command];
}

// BSD and util-linux `script` do not agree on whether the child's exit status
// is propagated (util-linux needs -e for it; the BSD flag set differs), so the
// status is reported from inside the pty instead of read off the wrapper. A run
// killed for hanging prints no marker, which reads as "no status", not zero.
const exitMarker = 'agentkit-install-exit=';

function reportedStatus(transcript: string): number | null {
  const reported = new RegExp(`^${exitMarker}(\\d+)$`, 'm').exec(transcript);
  return reported ? Number(reported[1]) : null;
}

// `script` hands the installer a pseudo-terminal, which is the only way to
// exercise the `-t 0` gate: a piped stdin is what every other test already has.
function installOnTty(
  home: string,
  keystrokes: string,
  extraArgs: string[] = [],
  options: { env?: Record<string, string>; shell?: string; timeoutMs?: number } = {},
) {
  const inner = options.shell ??
    ['bash', installScript, ...baseArgs, ...extraArgs].join(' ');
  const result = spawnSync('script', scriptArgv(`${inner}; printf '\\n${exitMarker}%s\\n' "$?"`), {
    cwd: repoRoot,
    env: { ...installEnv(home), ...(options.env ?? {}) },
    input: keystrokes,
    encoding: 'utf-8',
    timeout: options.timeoutMs ?? globalInstallTimeoutMs,
  });
  // A pty terminates lines with CRLF; comparing against installer output that
  // was written with plain LF would fail on the carriage returns alone.
  const stdout = (result.stdout ?? '').replaceAll('\r', '');
  return {
    status: reportedStatus(stdout),
    // A wizard that asks where nobody can answer does not fail, it stops: the
    // only evidence is the harness killing it, so the signal has to be visible.
    signal: result.signal,
    stdout,
    stderr: (result.stderr ?? '').replaceAll('\r', ''),
  };
}

function canonSkill(home: string, name: string) {
  return join(home, '.agentkit', 'skills', name);
}

// Symlink targets embed the temporary home, so the tree is compared by relative
// path and entry kind: what got installed, not where the fixture happens to be.
function listTree(root: string, prefix = ''): string[] {
  const entries = readdirSync(join(root, prefix), { withFileTypes: true });
  const listed: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const stats = lstatSync(join(root, relative));
    listed.push(`${stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'dir ' : 'file'} ${relative}`);
    if (stats.isDirectory()) listed.push(...listTree(root, relative));
  }
  return listed;
}

describe('installer skill-group wizard', () => {
  test('the pty wrapper runs on this machine, whichever script is installed', () => {
    expect(scriptArgv('CMD', 'util-linux')).toEqual(['-qec', 'CMD', '/dev/null']);
    expect(scriptArgv('CMD', 'bsd')).toEqual(['-q', '/dev/null', 'bash', '-c', 'CMD']);

    // The rest of this file is unreadable when the wrapper itself is wrong: a
    // rejected argv means empty output, so assertions about absent prompts pass
    // and only the ones expecting output fail. This says so in one line instead.
    const probe = spawnSync('script', scriptArgv('exit 0'), {
      encoding: 'utf-8',
      timeout: hangTimeoutMs,
    });
    expect(probe.error, `script flavour '${scriptFlavour()}' would not run`).toBeUndefined();
    expect(probe.status, probe.stderr).toBe(0);
  });

  test('a bare install on a terminal offers each optional group and remembers the answer', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-wizard-'));

    try {
      const first = installOnTty(home, 'y\n');
      expect(first.status, first.stderr).toBe(0);

      // The description comes from the manifest, so a group added there shows up
      // in the prompt without anyone editing the installer.
      expect(first.stdout).toContain('[groups] Optional skill groups');
      expect(first.stdout).toContain(
        '[groups]   product: Product-model skills: evidence-backed briefs and product review',
      );
      expect(first.stdout).toContain('[groups]   Install product? [y/N]');
      expect(first.stdout).toContain('Skill groups:    core product');

      for (const name of ['product-intelligence', 'product-review']) {
        expect(existsSync(join(canonSkill(home, name), 'SKILL.md')), `${name} installed`).toBe(true);
      }
      expect(readFileSync(join(home, '.agentkit', 'groups'), 'utf-8')).toContain('product');

      // The answer was persisted, so the upgrade must run straight through — the
      // whole point of asking once rather than every time.
      const upgrade = installOnTty(home, '');
      expect(upgrade.status, upgrade.stderr).toBe(0);
      expect(upgrade.stdout).not.toContain(promptMarker);
      expect(upgrade.stdout).toContain('Skill groups:    core product');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('a piped install never prompts, so CI cannot block on an unanswered question', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-wizard-'));

    try {
      const result = install(home);
      expect(result.status, result.stderr).toBe(0);

      // Both streams: a prompt written to stderr would hang a pipeline just as
      // surely as one written to stdout.
      expect(result.stdout).not.toContain(promptMarker);
      expect(result.stderr).not.toContain(promptMarker);
      expect(result.stdout).not.toContain('Optional skill groups');
      expect(result.stderr).not.toContain('Optional skill groups');
      expect(result.stdout).toContain('Skill groups:    core');
      expect(existsSync(canonSkill(home, 'product-review'))).toBe(false);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('a flagged install on a terminal is still unattended', () => {
    // A flag is an answer already given; asking again would make a scripted
    // terminal run — the shape a Makefile or a setup script takes — hang. Each
    // flag gets an untouched home so it is the flag being proven, not the
    // groups file a previous run in this loop would have left behind.
    for (const args of [['--with', 'product'], ['--all'], ['--without', 'product']]) {
      const home = mkdtempSync(join(tmpdir(), 'agentkit-wizard-'));
      try {
        const result = installOnTty(home, '', args);
        expect(result.status, `${args.join(' ')}: ${result.stderr}`).toBe(0);
        expect(result.stdout, `${args.join(' ')} must not prompt`).not.toContain(promptMarker);
      } finally {
        rmSync(home, { force: true, recursive: true });
      }
    }
  }, globalInstallTimeoutMs);

  test('declining every group installs exactly what a bare piped install installs', () => {
    const declined = mkdtempSync(join(tmpdir(), 'agentkit-wizard-declined-'));
    const piped = mkdtempSync(join(tmpdir(), 'agentkit-wizard-piped-'));

    try {
      // A bare newline is the answer someone gives by reflex; it must cost them
      // nothing relative to the install they would have got before the prompt.
      const answered = installOnTty(declined, '\n');
      expect(answered.status, answered.stderr).toBe(0);
      expect(answered.stdout).toContain(promptMarker);

      const reference = install(piped);
      expect(reference.status, reference.stderr).toBe(0);

      expect(listTree(declined)).toEqual(listTree(piped));
      expect(readFileSync(join(declined, '.agentkit', 'groups'), 'utf-8')).toBe(
        readFileSync(join(piped, '.agentkit', 'groups'), 'utf-8'),
      );
      // Sameness of the tree is not sameness of what it points at: a link that
      // resolved differently would install different skills under equal names.
      const link = join('.claude', 'skills', 'code-quality');
      expect(readlinkSync(join(declined, link)).replace(declined, '')).toBe(
        readlinkSync(join(piped, link)).replace(piped, ''),
      );
    } finally {
      rmSync(declined, { force: true, recursive: true });
      rmSync(piped, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('a CI runner that allocated a terminal is never asked', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-wizard-'));

    try {
      // Plenty of runners hand the job a pty — a docker executor, `docker run
      // -it`, Jenkins — so a terminal is not evidence that anyone is watching
      // it. Asking there does not degrade to a decline, it blocks the job until
      // something kills it, which is the one failure direction an installer
      // must not have.
      const result = installOnTty(home, '', [], {
        env: { CI: '1' },
        timeoutMs: hangTimeoutMs,
      });

      expect(result.signal, 'CI install blocked on an unanswered question').toBe(null);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain(promptMarker);
      expect(result.stdout).toContain('Skill groups:    core');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('a captured stdout is a non-interactive consumer, terminal stdin or not', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-wizard-'));

    try {
      // `install.sh | tee install.log` is ordinary ops practice, and it leaves
      // stdin a terminal while the output the operator would read goes into a
      // pipe. A question asked into that pipe is invisible and unanswerable.
      const log = join(home, 'install.log');
      const result = installOnTty(home, '', [], {
        shell: `bash ${installScript} ${baseArgs.join(' ')} 2>&1 | tee ${log}`,
        timeoutMs: hangTimeoutMs,
      });

      expect(result.signal, 'the piped-stdout install blocked on a question').toBe(null);
      // Both places, and the terminal is the one that matters: routing the
      // question to /dev/tty already keeps it out of the log, so a log-only
      // assertion passes whether or not the gate consults stdout at all.
      expect(result.stdout, 'asked on the terminal anyway').not.toContain(promptMarker);
      const captured = readFileSync(log, 'utf-8').replaceAll('\r', '');
      expect(captured).not.toContain(promptMarker);
      // Reaching the summary is what separates "declined and carried on" from
      // "asked, and the transcript simply had not got there yet".
      expect(captured).toContain('Skill groups:    core');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('no controlling terminal declines rather than asking into the void', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-wizard-'));

    try {
      // The one shape where the gate says "ask" but there is nowhere to ask:
      // stdin and stdout are terminals, yet /dev/tty cannot be opened. perl
      // rather than setsid(1), which is util-linux and absent on macOS; the
      // parent waits so the installer's exit status still comes back.
      const detach =
        `perl -MPOSIX -e 'my $p=fork; if($p){waitpid($p,0); exit($?>>8)} POSIX::setsid(); exec @ARGV or die' --`;
      const result = installOnTty(home, '', [], {
        shell: `${detach} bash ${installScript} ${baseArgs.join(' ')}`,
        timeoutMs: hangTimeoutMs,
      });

      expect(result.signal, 'the detached install blocked on a question').toBe(null);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain(promptMarker);
      // Silent would be wrong too: skipping the question is a decision the
      // operator has to be able to see, and to reverse with a flag.
      expect(result.stdout).toContain('[groups] No controlling terminal');
      expect(result.stdout).toContain('--with <group>');
      expect(result.stdout).toContain('Skill groups:    core');
      expect(existsSync(canonSkill(home, 'product-review'))).toBe(false);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('the explicit opt-outs suppress the question on a terminal', () => {
    for (
      const optOut of [
        { label: '--no-prompt', args: ['--no-prompt'], env: {} },
        { label: 'AGENTKIT_SKIP_PROMPT', args: [], env: { AGENTKIT_SKIP_PROMPT: '1' } },
      ]
    ) {
      const home = mkdtempSync(join(tmpdir(), 'agentkit-wizard-'));
      try {
        const result = installOnTty(home, '', optOut.args, {
          env: optOut.env,
          timeoutMs: hangTimeoutMs,
        });

        expect(result.signal, `${optOut.label} blocked`).toBe(null);
        expect(result.status, `${optOut.label}: ${result.stderr}`).toBe(0);
        expect(result.stdout, `${optOut.label} must not prompt`).not.toContain(promptMarker);
        expect(result.stdout).toContain('Skill groups:    core');
      } finally {
        rmSync(home, { force: true, recursive: true });
      }
    }
  }, globalInstallTimeoutMs);

  test('a project install does not ask, because it has nowhere to remember', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-wizard-'));
    const project = mkdtempSync(join(tmpdir(), 'agentkit-wizard-project-'));

    try {
      // Project installs persist nothing, so a wizard there would re-ask on
      // every single run — a nag, not a choice.
      const result = installOnTty(home, '', [], {
        shell: `bash ${installScript} ${project}`,
        timeoutMs: hangTimeoutMs,
      });

      expect(result.signal, 'the project install blocked on a question').toBe(null);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain(promptMarker);
      expect(existsSync(join(home, '.agentkit', 'groups'))).toBe(false);
    } finally {
      rmSync(home, { force: true, recursive: true });
      rmSync(project, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('a terminal upgrade after a declined install does not re-ask', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-wizard-'));

    try {
      expect(installOnTty(home, '\n').status).toBe(0);
      // Declining writes a groups file with no groups in it. Read as "nothing
      // remembered" rather than "core only", that file would re-ask forever.
      expect(readFileSync(join(home, '.agentkit', 'groups'), 'utf-8')).not.toContain('product');

      const upgrade = installOnTty(home, '');
      expect(upgrade.status, upgrade.stderr).toBe(0);
      expect(upgrade.stdout).not.toContain(promptMarker);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);
});

import { beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readSkillKits } from '../../scripts/skill-kits';

const repoRoot = dirname(dirname(import.meta.dir));
const installScript = join(repoRoot, 'install.sh');
const globalInstallTimeoutMs = 60_000;
// One answer per prompt the wizard will actually ask, straight from the
// manifest: under the `script` driver the keystrokes arrive once on stdin, so
// a fixed count would silently default every kit added after it to No.
const promptedKitCount = readSkillKits(repoRoot).kits
  .filter((kit) => kit.id !== 'core' && !kit.explicit).length;
// The one string a scripted run must never contain. Every non-TTY assertion
// greps the whole transcript for it, so it has to be the literal the installer
// prints rather than a paraphrase of it.
const promptMarker = '? [y/N]';
// A blocked wizard is stopped, while an isolated install can take over 30
// seconds under full-suite contention. Keep this below the outer deadline.
const hangTimeoutMs = 45_000;

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
    // These tests pin wizard behavior, not dependency fetching — a runner
    // whose registry view is broken must not be able to fail them.
    AGENTKIT_SKIP_SKILL_DEPS: '1',
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

// util-linux `script` drives a pty from `-c`; BSD `script`, which macOS ships,
// has no -c and clones termios from its own stdin, so blind-piped keystrokes
// race the reader there. expect allocates its own pty and only answers once it
// has seen the prompt, so macOS uses it instead of script entirely. Probe the
// tools rather than reading uname: what decides this is what is on PATH.
type PtyDriver = 'script' | 'expect' | 'none';
let ptyDriverCache: PtyDriver | undefined;

function ptyDriver(): PtyDriver {
  const forced = process.env.AGENTKIT_TEST_PTY_DRIVER;
  if (forced === 'script' || forced === 'expect' || forced === 'none') return forced;
  if (!ptyDriverCache) {
    if (spawnSync('script', ['-qec', 'true', '/dev/null'], { encoding: 'utf-8' }).status === 0) {
      ptyDriverCache = 'script';
    } else {
      ptyDriverCache = spawnSync('expect', ['-v'], { encoding: 'utf-8' }).status === 0
        ? 'expect'
        : 'none';
    }
  }
  return ptyDriverCache;
}

// Inside a Tcl double-quoted string these are substitution, not text: an
// unescaped [ in the prompt pattern would run its contents as a command.
function tclQuote(value: string): string {
  return `"${value.replaceAll(/[\\$[\]"]/g, (character) => `\\${character}`)}"`;
}

// Answer only after the prompt has actually been printed — the whole point of
// the driver. exp_continue loops so each declared kit gets its own answer,
// and a run that never prompts falls straight through to eof.
function expectProgram(command: string, keystrokes: string, timeoutSeconds: number): string {
  const lines = [
    `set timeout ${timeoutSeconds}`,
    'log_user 1',
    `spawn bash -c ${tclQuote(command)}`,
    'expect {',
  ];
  if (keystrokes.length > 0) {
    const typed = keystrokes.replaceAll('\n', '\r');
    lines.push(`  -ex ${tclQuote(promptMarker)} { send -- ${tclQuote(typed)}; exp_continue }`);
  }
  lines.push('  eof {}', '  timeout { exit 99 }', '}');
  return lines.join('\n');
}

interface PtyInvocation {
  file: string;
  args: string[];
  // Only the script form takes keystrokes on the spawner's stdin; expect types
  // them itself, and a second copy here would sit unread.
  input?: string;
}

function ptyInvocation(
  command: string,
  keystrokes: string,
  timeoutMs: number,
  driver: PtyDriver = ptyDriver(),
): PtyInvocation {
  if (driver === 'script') {
    return { file: 'script', args: ['-qec', command, '/dev/null'], input: keystrokes };
  }
  return {
    file: 'expect',
    args: ['-c', expectProgram(command, keystrokes, Math.ceil(timeoutMs / 1000))],
  };
}

// The agreed endpoint rather than a silent pass: without a pty driver the
// interactive cases cannot run anywhere, and the suite has to say which tool is
// missing instead of reporting green.
function noPtyDriver(): boolean {
  if (ptyDriver() !== 'none') return false;
  console.warn(
    '[wizard] no pty driver: script lacks -c and expect is not installed — interactive cases not exercised',
  );
  return true;
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
  const timeoutMs = options.timeoutMs ?? globalInstallTimeoutMs;
  const invocation = ptyInvocation(
    `${inner}; printf '\\n${exitMarker}%s\\n' "$?"`,
    keystrokes,
    timeoutMs,
  );
  const result = spawnSync(invocation.file, invocation.args, {
    cwd: repoRoot,
    env: { ...installEnv(home), ...(options.env ?? {}) },
    input: invocation.input,
    encoding: 'utf-8',
    timeout: timeoutMs,
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

// Compared by relative path and entry kind, since symlink targets embed the
// temporary home. Bun hoists or nests the same transitive dependency
// differently between two installs of one manifest and caches it under .bun;
// kit selection decides neither, so the interior it arranges is dropped. The
// node_modules entry itself stays, so a skill that never got its dependencies
// installed still breaks parity.
function listTree(root: string, prefix = ''): string[] {
  const entries = readdirSync(join(root, prefix), { withFileTypes: true });
  const listed: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === '.bun') continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const stats = lstatSync(join(root, relative));
    listed.push(`${stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'dir ' : 'file'} ${relative}`);
    if (stats.isDirectory() && entry.name !== 'node_modules') {
      listed.push(...listTree(root, relative));
    }
  }
  return listed;
}

// Each temp HOME is a full install, dependency trees included, on a shared
// tmpfs with a finite inode budget; a run killed mid-test never reaches its
// cleanup. Age-gated because a concurrent suite's live directories are minutes
// old, and deleting one out from under it would be worse than the leak.
const homePrefixes = ['agentkit-wizard-', 'agentkit-wizard-declined-', 'agentkit-wizard-piped-'];
const staleAfterMs = 60 * 60 * 1000;

function reapAbandonedHomes() {
  const now = Date.now();
  for (const entry of readdirSync(tmpdir())) {
    if (!homePrefixes.some((prefix) => entry.startsWith(prefix))) continue;
    const path = join(tmpdir(), entry);
    try {
      if (now - statSync(path).mtimeMs < staleAfterMs) continue;
      rmSync(path, { force: true, recursive: true });
    } catch {
      // Raced with its owner, or not ours to remove. Reaping is opportunistic
      // hygiene; failing the suite over it would trade a leak for a red build.
    }
  }
}

describe('installer skill-kit wizard', () => {
  beforeAll(reapAbandonedHomes);

  test('the pty driver runs on this machine, whichever tools are installed', () => {
    const viaScript = ptyInvocation('CMD', 'y\n', 20_000, 'script');
    expect(viaScript.file).toBe('script');
    expect(viaScript.args).toEqual(['-qec', 'CMD', '/dev/null']);
    expect(viaScript.input).toBe('y\n');

    // Pinned in full because macOS is where this runs and Linux is where it is
    // read: the condition (-ex on the prompt) is what makes the answer arrive
    // after the question instead of racing it.
    const viaExpect = ptyInvocation('CMD', 'y\n', 20_000, 'expect');
    expect(viaExpect.file).toBe('expect');
    expect(viaExpect.input).toBeUndefined();
    expect(viaExpect.args[0]).toBe('-c');
    expect(viaExpect.args[1]).toBe(
      [
        'set timeout 20',
        'log_user 1',
        'spawn bash -c "CMD"',
        'expect {',
        '  -ex "? \\[y/N\\]" { send -- "y\r"; exp_continue }',
        '  eof {}',
        '  timeout { exit 99 }',
        '}',
      ].join('\n'),
    );

    // No keystrokes means no answering branch at all: a send of nothing under
    // exp_continue would spin on the same prompt forever.
    expect(ptyInvocation('CMD', '', 20_000, 'expect').args[1]).not.toContain('exp_continue');

    if (noPtyDriver()) return;
    // The rest of this file is unreadable when the driver itself is wrong: a
    // rejected argv means empty output, so assertions about absent prompts pass
    // and only the ones expecting output fail. This says so in one line instead.
    const invocation = ptyInvocation('exit 0', '', hangTimeoutMs);
    const probe = spawnSync(invocation.file, invocation.args, {
      input: invocation.input,
      encoding: 'utf-8',
      timeout: hangTimeoutMs,
    });
    expect(probe.error, `pty driver '${ptyDriver()}' would not run`).toBeUndefined();
    expect(probe.status, probe.stderr).toBe(0);
  });

  test('Tcl substitution characters in a command cannot escape the expect program', () => {
    // The expect path is the only one building a Tcl program, so its quoting is
    // where a bracket in a temp path becomes command substitution.
    expect(tclQuote('a[b]c')).toBe('"a\\[b\\]c"');
    expect(tclQuote('$HOME "x" \\y')).toBe('"\\$HOME \\"x\\" \\\\y"');
    expect(ptyInvocation('echo [exec id]', '', 20_000, 'expect').args[1]).toContain(
      'spawn bash -c "echo \\[exec id\\]"',
    );
  });

  test('a bare install on a terminal offers each optional kit and remembers the answer', () => {
    if (noPtyDriver()) return;
    const home = mkdtempSync(join(tmpdir(), 'agentkit-wizard-'));

    try {
      const first = installOnTty(home, 'y\n'.repeat(promptedKitCount));
      expect(first.status, first.stderr).toBe(0);

      // The description comes from the manifest, so a kit added there shows up
      // in the prompt without anyone editing the installer.
      expect(first.stdout).toContain('[kits] Optional skill kits');
      expect(first.stdout).toContain(
        '[kits]   product: Product-model skills: evidence-backed briefs and product review',
      );
      expect(first.stdout).toContain('[kits]   Install product? [y/N]');
      expect(first.stdout).toContain(
        '[kits]   memory: Persistent brain vault with a learning loop: reflect, meditate, ruminate',
      );
      expect(first.stdout).toContain('[kits]   Install memory? [y/N]');
      expect(first.stdout).toContain('Skill kits:    core memory product');

      for (
        const name of [
          'product-intelligence',
          'product-review',
          'reflect',
          'meditate',
          'ruminate',
        ]
      ) {
        expect(existsSync(join(canonSkill(home, name), 'SKILL.md')), `${name} installed`).toBe(true);
      }
      const persisted = readFileSync(join(home, '.agentkit', 'kits'), 'utf-8');
      expect(persisted).toContain('product');
      expect(persisted).toContain('memory');

      // The answer was persisted, so the upgrade must run straight through — the
      // whole point of asking once rather than every time.
      const upgrade = installOnTty(home, '');
      expect(upgrade.status, upgrade.stderr).toBe(0);
      expect(upgrade.stdout).not.toContain(promptMarker);
      expect(upgrade.stdout).toContain('Skill kits:    core memory product');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs * 2);

  test('a piped install never prompts, so CI cannot block on an unanswered question', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentkit-wizard-'));

    try {
      const result = install(home);
      expect(result.status, result.stderr).toBe(0);

      // Both streams: a prompt written to stderr would hang a pipeline just as
      // surely as one written to stdout.
      expect(result.stdout).not.toContain(promptMarker);
      expect(result.stderr).not.toContain(promptMarker);
      expect(result.stdout).not.toContain('Optional skill kits');
      expect(result.stderr).not.toContain('Optional skill kits');
      expect(result.stdout).toContain('Skill kits:    core');
      expect(existsSync(canonSkill(home, 'product-review'))).toBe(false);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('a flagged install on a terminal is still unattended', () => {
    if (noPtyDriver()) return;
    // A flag is an answer already given; asking again would make a scripted
    // terminal run — the shape a Makefile or a setup script takes — hang. Each
    // flag gets an untouched home so it is the flag being proven, not the
    // kits file a previous run in this loop would have left behind.
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
  }, globalInstallTimeoutMs * 3);

  test('declining every kit installs exactly what a bare piped install installs', () => {
    if (noPtyDriver()) return;
    const declined = mkdtempSync(join(tmpdir(), 'agentkit-wizard-declined-'));
    const piped = mkdtempSync(join(tmpdir(), 'agentkit-wizard-piped-'));

    try {
      // A bare newline is the answer someone gives by reflex; it must cost them
      // nothing relative to the install they would have got before the prompt.
      const answered = installOnTty(declined, '\n'.repeat(promptedKitCount));
      expect(answered.status, answered.stderr).toBe(0);
      expect(answered.stdout).toContain(promptMarker);

      const reference = install(piped);
      expect(reference.status, reference.stderr).toBe(0);

      expect(listTree(declined)).toEqual(listTree(piped));
      expect(readFileSync(join(declined, '.agentkit', 'kits'), 'utf-8')).toBe(
        readFileSync(join(piped, '.agentkit', 'kits'), 'utf-8'),
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
  }, globalInstallTimeoutMs * 2);

  test('a CI runner that allocated a terminal is never asked', () => {
    if (noPtyDriver()) return;
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
      expect(result.stdout).toContain('Skill kits:    core');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('a captured stdout is a non-interactive consumer, terminal stdin or not', () => {
    if (noPtyDriver()) return;
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
      expect(captured).toContain('Skill kits:    core');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('no controlling terminal declines rather than asking into the void', () => {
    if (noPtyDriver()) return;
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
      expect(result.stdout).toContain('[kits] No controlling terminal');
      expect(result.stdout).toContain('--with <kit>');
      expect(result.stdout).toContain('Skill kits:    core');
      expect(existsSync(canonSkill(home, 'product-review'))).toBe(false);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('the explicit opt-outs suppress the question on a terminal', () => {
    if (noPtyDriver()) return;
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
        expect(result.stdout).toContain('Skill kits:    core');
      } finally {
        rmSync(home, { force: true, recursive: true });
      }
    }
  }, globalInstallTimeoutMs * 2);

  test('a project install does not ask, because it has nowhere to remember', () => {
    if (noPtyDriver()) return;
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
      expect(existsSync(join(home, '.agentkit', 'kits'))).toBe(false);
    } finally {
      rmSync(home, { force: true, recursive: true });
      rmSync(project, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs);

  test('a terminal upgrade after a declined install does not re-ask', () => {
    if (noPtyDriver()) return;
    const home = mkdtempSync(join(tmpdir(), 'agentkit-wizard-'));

    try {
      expect(installOnTty(home, '\n'.repeat(promptedKitCount)).status).toBe(0);
      // Declining writes a kits file with no kits in it. Read as "nothing
      // remembered" rather than "core only", that file would re-ask forever.
      expect(readFileSync(join(home, '.agentkit', 'kits'), 'utf-8')).not.toContain('product');

      const upgrade = installOnTty(home, '');
      expect(upgrade.status, upgrade.stderr).toBe(0);
      expect(upgrade.stdout).not.toContain(promptMarker);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  }, globalInstallTimeoutMs * 2);
});

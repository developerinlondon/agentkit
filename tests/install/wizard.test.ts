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

function installEnv(home: string) {
  return {
    ...process.env,
    AGENTKIT_PLATFORM: 'linux',
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    AGENTKIT_HOME: join(home, '.agentkit'),
    CODEX_HOME: join(home, '.codex'),
  };
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

// `script` hands the installer a pseudo-terminal, which is the only way to
// exercise the `-t 0` gate: a piped stdin is what every other test already has.
function installOnTty(home: string, keystrokes: string, extraArgs: string[] = []) {
  const command = ['bash', installScript, ...baseArgs, ...extraArgs].join(' ');
  const result = spawnSync('script', ['-qec', command, '/dev/null'], {
    cwd: repoRoot,
    env: installEnv(home),
    input: keystrokes,
    encoding: 'utf-8',
    timeout: globalInstallTimeoutMs,
  });
  // A pty terminates lines with CRLF; comparing against installer output that
  // was written with plain LF would fail on the carriage returns alone.
  return {
    status: result.status,
    stdout: (result.stdout ?? '').replaceAll('\r', ''),
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

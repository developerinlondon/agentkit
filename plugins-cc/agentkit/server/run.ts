// Safe CLI runner. Spawns a binary with an argv array — never a shell string —
// so no argument can be interpreted as a shell operator (injection-proof by
// construction). Callers pass a fixed, read-only subcommand plus already-split
// arguments; there is no shell, no glob expansion, and no word splitting.

export interface CliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exit_code: number;
}

const COMMAND_NOT_FOUND = 127;

export async function runCli(argv: string[], cwd?: string): Promise<CliResult> {
  if (argv.length === 0) {
    return { ok: false, stdout: '', stderr: 'runCli: empty argv', exit_code: COMMAND_NOT_FOUND };
  }

  try {
    const proc = Bun.spawn(argv, {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    });

    const [stdout, stderr, exit_code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { ok: exit_code === 0, stdout, stderr, exit_code };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      stdout: '',
      stderr: `failed to spawn ${argv[0]}: ${message}`,
      exit_code: COMMAND_NOT_FOUND,
    };
  }
}

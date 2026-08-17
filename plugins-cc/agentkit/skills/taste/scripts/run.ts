export interface Run {
  ok: boolean;
  out: string;
  err: string;
  timedOut: boolean;
  // null when the process never started at all. A caller that treats a failing
  // exit code as an answer needs to tell that apart from a missing program,
  // which is no answer.
  code: number | null;
}

// Spawned asynchronously so the deadline is a timer on a running event loop: a
// blocking spawn holds its caller's thread, leaving the bound no way to fire —
// and an unresponsive host would then wedge whatever is running this instead of
// being reported. A command that cannot start at all is a failed run, not a
// throw: "no such program" is an answer this caller acts on.
export async function runBounded(
  cmd: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<Run> {
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    child = Bun.spawn({ cmd, cwd, env, stdout: 'pipe', stderr: 'pipe' });
  } catch (error) {
    return { ok: false, out: '', err: (error as Error).message, timedOut: false, code: null };
  }

  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);

  try {
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await child.exited;
    return {
      ok: child.exitCode === 0,
      out: out.trim(),
      err: err.trim(),
      timedOut,
      code: child.exitCode,
    };
  } finally {
    clearTimeout(deadline);
  }
}

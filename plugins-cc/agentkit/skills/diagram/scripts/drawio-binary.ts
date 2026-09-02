// Locating and launching draw.io Desktop headlessly.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export class DrawioError extends Error {}

export const INSTALL_HINT = "see references/stencil-register.md for the headless install recipe";

// Electron prints Chromium's dbus and zygote complaints to the same stream as
// the version, so the version is the last line that looks like one.
export function parseVersion(output: string): string {
  const line = output.trim().split("\n").filter((l) => /^\s*v?\d+\.\d+\.\d+\s*$/.test(l)).pop();
  return (line ?? "").trim().replace(/^v/, "");
}

export function binaryCandidates(env: NodeJS.ProcessEnv, home: string): string[] {
  return [
    env.AGENTKIT_DRAWIO,
    join(home, ".agentkit/diagram/drawio/squashfs-root/drawio"),
    "/opt/drawio/drawio",
    "/usr/bin/drawio",
    "/usr/local/bin/drawio",
    "/Applications/draw.io.app/Contents/MacOS/draw.io",
  ].filter((c): c is string => Boolean(c));
}

// The AppImage ships chrome-sandbox unprivileged, and Electron aborts rather
// than run unsandboxed on its own. A distro package installs it setuid root, so
// the flag is decided by what is actually on disk instead of being hardcoded.
export function needsNoSandbox(binary: string): boolean {
  const helper = join(dirname(binary), "chrome-sandbox");
  if (!existsSync(helper)) return false;
  const st = statSync(helper);
  return !(st.uid === 0 && (st.mode & 0o4000) !== 0);
}

// Electron initialises a display even for --version, so a server with no X
// server cannot run the CLI directly. xvfb-run supplies one for the process.
export function needsXvfb(env: NodeJS.ProcessEnv, platform: string): boolean {
  return platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

function onPath(cmd: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? "").split(":").filter(Boolean).some((dir) => existsSync(join(dir, cmd)));
}

export interface Launcher {
  binary: string;
  wrapper?: string;
  sandbox: string[];
}

export function resolveLauncher(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: string,
): Launcher {
  const binary = binaryCandidates(env, home).find((c) => existsSync(c));
  if (!binary) throw new DrawioError(`no draw.io Desktop binary found — ${INSTALL_HINT}`);
  const wrapper = needsXvfb(env, platform) ? "xvfb-run" : undefined;
  if (wrapper && !onPath(wrapper, env)) {
    throw new DrawioError(`no X server and no xvfb-run on PATH — draw.io Desktop needs one; ${INSTALL_HINT}`);
  }
  return { binary, wrapper, sandbox: needsNoSandbox(binary) ? ["--no-sandbox"] : [] };
}

export const RUN_TIMEOUT_MS = 180000;

// Chromium narrates dbus and zygote failures on every headless start, so the
// real message is whatever is left. When nothing is, the noise is the only
// account of the failure there is and dropping it leaves the operator with
// "draw.io failed:" and a blank line.
export function readableStderr(text: string): string {
  const trimmed = text.trim();
  const kept = trimmed.split("\n").filter((l) => !/ERROR:|zygote/.test(l)).join("\n").trim();
  return kept === "" ? trimmed : kept;
}

// Killed as a group, not as a process: xvfb-run is a shell script, so signalling
// it leaves the browser it wrapped running with the X server pulled away.
// Measured on this host — both survived a SIGTERM to the wrapper alone.
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

export function run(
  launcher: Launcher,
  args: string[],
  timeoutMs = RUN_TIMEOUT_MS,
): Promise<string> {
  const { binary, wrapper, sandbox } = launcher;
  const cmd = wrapper ?? binary;
  const argv = wrapper ? ["-a", binary, ...sandbox, ...args] : [...sandbox, ...args];
  // detached makes the child a process-group leader, which is what lets the
  // timeout reach everything it spawned.
  const child = spawn(cmd, argv, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  let timedOut = false;
  child.stdout.on("data", (d: Buffer) => void (out += d.toString()));
  child.stderr.on("data", (d: Buffer) => void (err += d.toString()));
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child.pid);
  }, timeoutMs);
  return new Promise<string>((resolve, reject) => {
    child.on("error", (e: Error) => reject(new DrawioError(`could not start ${cmd}: ${e.message}`)));
    child.on("close", (code) => {
      if (timedOut) {
        reject(new DrawioError(`draw.io timed out after ${timeoutMs}ms and its process group was killed`));
      } else if (code === 0) {
        resolve(out);
      } else {
        reject(new DrawioError(`draw.io failed:\n${readableStderr(err || out)}`));
      }
    });
  }).finally(() => clearTimeout(timer));
}

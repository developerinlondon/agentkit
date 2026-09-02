// Locating and launching draw.io Desktop headlessly.

import { execFileSync } from "node:child_process";
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

export function run(launcher: Launcher, args: string[]): string {
  const { binary, wrapper, sandbox } = launcher;
  const cmd = wrapper ?? binary;
  const argv = wrapper ? ["-a", binary, ...sandbox, ...args] : [...sandbox, ...args];
  try {
    return execFileSync(cmd, argv, { encoding: "utf8", stdio: "pipe", timeout: 180000 });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    const text = (err.stderr ?? err.message).trim();
    throw new DrawioError(
      `draw.io failed:\n${text.split("\n").filter((l) => !/ERROR:|zygote/.test(l)).join("\n")}`,
    );
  }
}

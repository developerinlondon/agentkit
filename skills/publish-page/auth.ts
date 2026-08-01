import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

interface AuthorizationOptions {
  endpoint: string;
  tokenPath: string;
  deviceName?: string;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  open?: (url: string) => void;
  output?: (message: string) => void;
}

function openBrowser(url: string) {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    Bun.spawn([command, url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // The printed verification URL remains usable when no opener is installed.
  }
}

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function loadOrAuthorize(options: AuthorizationOptions): Promise<string> {
  if (existsSync(options.tokenPath)) {
    const existing = (await readFile(options.tokenPath, "utf8")).trim();
    if (existing) return existing;
  }
  const fetcher = options.fetcher ?? fetch;
  const output = options.output ?? console.error;
  const started = await fetcher(`${options.endpoint}/api/device/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_name: options.deviceName ?? hostname() }),
  });
  if (!started.ok) throw new Error(`device authorization failed: HTTP ${started.status}`);
  const authorization = await started.json() as {
    device_code: string;
    user_code: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  };
  output(`Sign in to AgentKit Pages and approve code ${authorization.user_code}:`);
  output(authorization.verification_uri_complete);
  (options.open ?? openBrowser)(authorization.verification_uri_complete);
  let interval = Math.max(5, authorization.interval);
  const attempts = Math.ceil(authorization.expires_in / interval);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await (options.sleep ?? wait)(interval * 1000);
    const response = await fetcher(`${options.endpoint}/api/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: authorization.device_code }),
    });
    const body = await response.json() as { access_token?: string; error?: string };
    if (response.ok && body.access_token) {
      await mkdir(dirname(options.tokenPath), { recursive: true, mode: 0o700 });
      await writeFile(options.tokenPath, `${body.access_token}\n`, { mode: 0o600 });
      await chmod(options.tokenPath, 0o600);
      return body.access_token;
    }
    if (body.error === "slow_down") {
      interval += 5;
      continue;
    }
    if (body.error !== "authorization_pending") {
      throw new Error(`device authorization failed: ${body.error || `HTTP ${response.status}`}`);
    }
  }
  throw new Error("device authorization expired before approval");
}

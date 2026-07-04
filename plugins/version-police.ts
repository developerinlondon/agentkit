import type { PluginInput } from '@opencode-ai/plugin';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, isAbsolute, resolve, basename } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// A pin is a single dependency version declaration found in a manifest.
// `raw` is the source line (used for inline-override detection); `inlineAllow`
// is precomputed by the parser because it needs surrounding-line context.
// ---------------------------------------------------------------------------

export type Ecosystem = 'npm' | 'cargo' | 'pypi' | 'docker' | 'go';

export interface Pin {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  raw: string;
  inlineAllow: boolean;
}

interface VersionPoliceConfig {
  enabled: boolean;
  exceptions: string[];
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 2500;
const SKIP_SPEC = /^(latest|\*|workspace:|file:|link:|git\+|https?:)/i;

// ---------------------------------------------------------------------------
// Config + kill switch
// ---------------------------------------------------------------------------

function getAgentkitConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, 'agentkit', 'config.yaml');
}

export function loadConfig(): VersionPoliceConfig {
  const defaults: VersionPoliceConfig = { enabled: true, exceptions: [] };
  try {
    const content = readFileSync(getAgentkitConfigPath(), 'utf-8');
    const lines = content.split('\n');
    let inSection = false;
    const sectionLines: string[] = [];
    for (const line of lines) {
      if (/^version-police:/.test(line)) {
        inSection = true;
        continue;
      }
      if (inSection) {
        if (/^\S/.test(line)) break;
        sectionLines.push(line);
      }
    }
    if (sectionLines.length === 0) return defaults;
    const section = sectionLines.join('\n');
    const enabled = !/enabled:\s*false/i.test(section);
    const exMatch = section.match(/exceptions:\s*\n((?:\s*-\s*.+\n?)*)/);
    const exceptions = exMatch
      ? [...exMatch[1].matchAll(/^\s*-\s+(.+)$/gm)].map((m) =>
        m[1].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim()
      )
      : [];
    return { enabled, exceptions };
  } catch {
    return defaults;
  }
}

export function isDisabled(config: VersionPoliceConfig): boolean {
  if (!config.enabled) return true;
  const skip = process.env.AGENTKIT_SKIP_HOOKS || '';
  return skip.split(',').map((s) => s.trim()).includes('version-police');
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

export function inlineAllow(line: string, prevLine: string, pkg: string): boolean {
  for (const candidate of [line, prevLine]) {
    const m = candidate.match(/version-police:\s*allow\b(?:\s+(\S+))?/i);
    if (!m) continue;
    const named = m[1];
    if (!named || named === '*' || named === pkg) return true;
  }
  return false;
}

export function matchesException(name: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === name) return true;
    if (pattern.includes('*')) {
      const rx = new RegExp(
        '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
      );
      if (rx.test(name)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

export function parseVersion(v: string): [number, number, number] {
  const cleaned = v.replace(/^[\^~>=<v\s]+/, '').split(/[-+]/)[0];
  const parts = cleaned.split('.').map((p) => parseInt(p, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

export function majorLag(pinned: string, latest: string): number {
  return parseVersion(latest)[0] - parseVersion(pinned)[0];
}

function isBehind(pinned: string, latest: string): boolean {
  const p = parseVersion(pinned);
  const l = parseVersion(latest);
  for (let i = 0; i < 3; i++) {
    if (l[i] > p[i]) return true;
    if (l[i] < p[i]) return false;
  }
  return false;
}

export function analyzePin(
  pin: Pin,
  latest: string | null,
  config: VersionPoliceConfig,
): 'block' | 'warn' | 'ok' {
  if (pin.inlineAllow) return 'ok';
  if (matchesException(pin.name, config.exceptions)) return 'ok';
  if (!latest) return 'ok'; // fail open: could not determine latest
  if (majorLag(pin.version, latest) >= 1) return 'block';
  if (isBehind(pin.version, latest)) return 'warn';
  return 'ok';
}

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------

function cleanSpec(spec: string): string | null {
  const trimmed = spec.trim();
  if (SKIP_SPEC.test(trimmed)) return null;
  const version = trimmed.replace(/^[\^~>=<\s]+/, '');
  if (!/^\d+\.\d+/.test(version)) return null;
  return version;
}

function parseNpm(content: string): Pin[] {
  const pins: Pin[] = [];
  let pkg: Record<string, Record<string, string>>;
  try {
    pkg = JSON.parse(content);
  } catch {
    return pins;
  }
  const groups = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  for (const group of groups) {
    const deps = pkg[group];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string') continue;
      const version = cleanSpec(spec);
      if (!version) continue;
      // JSON has no comments — inline override is never available here.
      pins.push({ ecosystem: 'npm', name, version, raw: `"${name}": "${spec}"`, inlineAllow: false });
    }
  }
  return pins;
}

function parseLineManifest(
  content: string,
  ecosystem: Ecosystem,
  matcher: (line: string, inDeps: boolean) => { name: string; version: string } | null,
  sectionGate?: (line: string) => boolean | null,
): Pin[] {
  const pins: Pin[] = [];
  const lines = content.split('\n');
  let inDeps = sectionGate ? false : true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (sectionGate) {
      const gate = sectionGate(line);
      if (gate !== null) {
        inDeps = gate;
        continue;
      }
    }
    const hit = matcher(line, inDeps);
    if (!hit) continue;
    const prev = i > 0 ? lines[i - 1] : '';
    pins.push({
      ecosystem,
      name: hit.name,
      version: hit.version,
      raw: line,
      inlineAllow: inlineAllow(line, prev, hit.name),
    });
  }
  return pins;
}

function parseCargo(content: string): Pin[] {
  return parseLineManifest(
    content,
    'cargo',
    (line, inDeps) => {
      if (!inDeps) return null;
      const m = line.match(/^\s*([\w-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*\bversion\s*=\s*"([^"]+)")/);
      if (!m) return null;
      const version = cleanSpec(m[2] || m[3] || '');
      return version ? { name: m[1], version } : null;
    },
    (line) => {
      if (/^\s*\[.*dependencies.*\]/.test(line)) return true;
      if (/^\s*\[/.test(line)) return false;
      return null;
    },
  );
}

function parsePypi(content: string): Pin[] {
  return parseLineManifest(content, 'pypi', (line) => {
    // requirements.txt / PEP 508: pkg==1.2.3 ; poetry: pkg = "^1.2.3"
    const pep = line.match(/^\s*["']?([A-Za-z0-9._-]+)["']?\s*==\s*["']?([0-9][^"'\s;,\]]*)/);
    if (pep) return { name: pep[1], version: pep[2] };
    const poetry = line.match(/^\s*([A-Za-z0-9._-]+)\s*=\s*"([\^~>=<]*[0-9][^"]*)"/);
    if (poetry) {
      const version = cleanSpec(poetry[2]);
      if (version && poetry[1] !== 'python') return { name: poetry[1], version };
    }
    return null;
  });
}

function parseDocker(content: string): Pin[] {
  return parseLineManifest(content, 'docker', (line) => {
    const from = line.match(/^\s*FROM\s+([^\s:@]+):([^\s@]+)/i);
    const compose = line.match(/^\s*image:\s*["']?([^\s:"'@]+):([^\s"'@]+)/i);
    const m = from || compose;
    if (!m) return null;
    const tag = m[2].split('-')[0];
    if (!/^\d+(\.\d+)*$/.test(tag)) return null;
    return { name: m[1], version: tag };
  });
}

function parseGo(content: string): Pin[] {
  return parseLineManifest(content, 'go', (line) => {
    const m = line.match(/^\s*(?:require\s+)?([\w.\-/]+\.[\w.\-/]+)\s+v(\d+\.\d+\.\d+)/);
    if (!m) return null;
    return { name: m[1], version: m[2] };
  });
}

export function parsePins(filePath: string, content: string): Pin[] {
  const name = basename(filePath).toLowerCase();
  if (name === 'package.json') return parseNpm(content);
  if (name === 'cargo.toml') return parseCargo(content);
  if (name === 'pyproject.toml' || /^requirements.*\.txt$/.test(name)) return parsePypi(content);
  if (name === 'dockerfile' || name.endsWith('.dockerfile')) return parseDocker(content);
  if (/^(docker-)?compose.*\.ya?ml$/.test(name)) return parseDocker(content);
  if (name === 'go.mod') return parseGo(content);
  return [];
}

export function isManifest(filePath: string): boolean {
  return /^(package\.json|cargo\.toml|pyproject\.toml|go\.mod|dockerfile)$|^requirements.*\.txt$|\.dockerfile$|^(docker-)?compose.*\.ya?ml$/i
    .test(basename(filePath));
}

export function changedPins(filePath: string, newContent: string, oldContent: string): Pin[] {
  const oldPins = parsePins(filePath, oldContent);
  const newPins = parsePins(filePath, newContent);
  return newPins.filter(
    (np) => !oldPins.some((op) => op.name === np.name && op.version === np.version),
  );
}

// ---------------------------------------------------------------------------
// Registry lookup + on-disk cache
// ---------------------------------------------------------------------------

type Cache = Record<string, { v: string; t: number }>;

function cachePath(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'agentkit', 'version-police.json');
}

export function cachedVersion(cache: Cache, key: string, now: number): string | null {
  const entry = cache[key];
  if (!entry) return null;
  if (now - entry.t > CACHE_TTL_MS) return null;
  return entry.v;
}

function readCache(path: string): Cache {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Cache;
  } catch {
    return {};
  }
}

function writeCache(path: string, cache: Cache): void {
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(cache));
  } catch {
    // cache is best-effort; ignore write failures
  }
}

async function fetchJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      headers: { 'User-Agent': 'agentkit-version-police' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // fail open on any network error / timeout
  }
}

async function fetchLatest(pin: Pin): Promise<string | null> {
  if (pin.ecosystem === 'npm') {
    const data = await fetchJson(`https://registry.npmjs.org/${pin.name.replace('/', '%2F')}/latest`);
    return data?.version ?? null;
  }
  if (pin.ecosystem === 'pypi') {
    const data = await fetchJson(`https://pypi.org/pypi/${pin.name}/json`);
    return data?.info?.version ?? null;
  }
  if (pin.ecosystem === 'cargo') {
    const data = await fetchJson(`https://crates.io/api/v1/crates/${pin.name}`);
    return data?.crate?.max_stable_version ?? data?.crate?.newest_version ?? null;
  }
  if (pin.ecosystem === 'go') {
    const escaped = pin.name.replace(/([A-Z])/g, (c) => '!' + c.toLowerCase());
    const data = await fetchJson(`https://proxy.golang.org/${escaped}/@latest`);
    return data?.Version ?? null;
  }
  if (pin.ecosystem === 'docker') {
    const repo = pin.name.includes('/') ? pin.name : `library/${pin.name}`;
    const data = await fetchJson(
      `https://hub.docker.com/v2/repositories/${repo}/tags?page_size=100&ordering=last_updated`,
    );
    const tags: string[] = (data?.results ?? [])
      .map((r: { name: string }) => r.name)
      .filter((t: string) => /^\d+(\.\d+)*$/.test(t));
    if (tags.length === 0) return null;
    return tags.sort((a, b) => majorLag(a, b) || parseVersion(b)[1] - parseVersion(a)[1])[0];
  }
  return null;
}

type GetLatest = (pin: Pin) => Promise<string | null>;

function diskGetLatest(path: string): GetLatest {
  const cache = readCache(path);
  return async (pin: Pin) => {
    const key = `${pin.ecosystem}:${pin.name}`;
    const hit = cachedVersion(cache, key, Date.now());
    if (hit) return hit;
    const latest = await fetchLatest(pin);
    if (latest) {
      cache[key] = { v: latest, t: Date.now() };
      writeCache(path, cache);
    }
    return latest;
  };
}

export async function evaluatePins(
  pins: Pin[],
  getLatest: GetLatest,
  config: VersionPoliceConfig,
): Promise<{ blocks: string[]; warns: string[] }> {
  const blocks: string[] = [];
  const warns: string[] = [];
  for (const pin of pins) {
    if (pin.inlineAllow || matchesException(pin.name, config.exceptions)) continue;
    const latest = await getLatest(pin);
    const verdict = analyzePin(pin, latest, config);
    if (verdict === 'block') {
      blocks.push(
        `${pin.name} pinned at ${pin.version} is ${majorLag(pin.version, latest!)} major version(s) ` +
          `behind latest ${latest} (${pin.ecosystem})`,
      );
    } else if (verdict === 'warn') {
      warns.push(`${pin.name} ${pin.version} -> latest ${latest} (${pin.ecosystem})`);
    }
  }
  return { blocks, warns };
}

function blockMessage(blocks: string[]): string {
  return (
    `BLOCKED: stale major dependency version(s) detected by version-police.\n` +
    `${'='.repeat(50)}\n` +
    blocks.map((b, i) => `${i + 1}. ${b}`).join('\n') +
    `\n\n` +
    `These pins are at least one MAJOR version behind the live registry — likely\n` +
    `recalled from training data. Use the current major version instead.\n\n` +
    `If a pin is deliberate, override it:\n` +
    `  - Inline (non-JSON manifests): add on the pin line or the line above:\n` +
    `      # version-police: allow <package> -- <reason>\n` +
    `  - Config (any manifest, incl. package.json): add to ~/.config/agentkit/config.yaml:\n` +
    `      version-police:\n` +
    `        exceptions:\n` +
    `          - <package>\n\n` +
    `Disable entirely: version-police.enabled: false, or\n` +
    `AGENTKIT_SKIP_HOOKS=version-police.`
  );
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export default async function versionPolice(ctx: PluginInput) {
  const config = loadConfig();

  return {
    'tool.execute.before': async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> },
    ): Promise<void> => {
      const toolName = input.tool?.toLowerCase();
      if (toolName !== 'edit' && toolName !== 'write') return;
      if (isDisabled(config)) return;

      const args = output.args;
      const filePath = (args.filePath || args.file_path || args.path) as string | undefined;
      if (!filePath || !isManifest(filePath)) return;

      const absPath = isAbsolute(filePath) ? filePath : resolve(ctx.directory, filePath);
      let oldContent = '';
      try {
        oldContent = readFileSync(absPath, 'utf-8');
      } catch {
        // new file — every pin is "changed"
      }

      let newContent: string;
      if (toolName === 'write') {
        newContent = (args.content as string) || '';
      } else {
        const oldString = (args.oldString as string) || '';
        const newString = (args.newString as string) || '';
        newContent = args.replaceAll
          ? oldContent.split(oldString).join(newString)
          : oldContent.replace(oldString, newString);
      }
      if (!newContent) return;

      const pins = changedPins(filePath, newContent, oldContent);
      if (pins.length === 0) return;

      const { blocks, warns } = await evaluatePins(pins, diskGetLatest(cachePath()), config);
      for (const w of warns) {
        console.warn(`[version-police] OUTDATED (minor/patch, non-blocking): ${w}`);
      }
      if (blocks.length > 0) {
        throw new Error(blockMessage(blocks));
      }
    },
  };
}

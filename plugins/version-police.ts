import type { PluginInput } from '@opencode-ai/plugin';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const HELM_CHART_FILE = /Chart\.yaml$/;
const PACKAGE_JSON_FILE = /package\.json$/;
const CARGO_TOML_FILE = /Cargo\.toml$/;

const checkedThisSession = new Set<string>();

function checkHelmVersions(filePath: string): string[] {
  const warnings: string[] = [];
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return warnings;
  }

  const depRegex =
    /^\s+-\s+name:\s*["']?([^"'\n]+)["']?\s*\n\s+version:\s*["']?([^"'\n]+)["']?\s*\n\s+repository:\s*["']?([^"'\n]+)["']?/gm;
  let match;
  while ((match = depRegex.exec(content)) !== null) {
    const [, name, version, repo] = match;
    const cacheKey = `helm:${repo}/${name}`;
    if (checkedThisSession.has(cacheKey)) continue;
    checkedThisSession.add(cacheKey);

    try {
      const repoAlias = Buffer.from(repo).toString('base64').slice(0, 12).replace(
        /[^a-z0-9]/gi,
        '',
      );
      spawnSync('helm', ['repo', 'add', repoAlias, repo], {
        timeout: 15000,
        stdio: 'ignore',
      });
      spawnSync('helm', ['repo', 'update', repoAlias], {
        timeout: 15000,
        stdio: 'ignore',
      });

      const result = spawnSync(
        'helm',
        ['search', 'repo', `${repoAlias}/${name}`, '--versions', '-o', 'json'],
        { timeout: 15000, encoding: 'utf-8' },
      );

      if (result.status === 0 && result.stdout) {
        const versions = JSON.parse(result.stdout);
        if (versions.length > 0) {
          const latest = versions[0].version;
          if (latest !== version) {
            warnings.push(
              `OUTDATED: ${name} ${version} -> latest is ${latest} (${repo})`,
            );
          } else {
            warnings.push(`OK: ${name} ${version} is latest`);
          }
        }
      }
    } catch {
      warnings.push(`SKIP: Could not check ${name} ${version} (network/timeout)`);
    }
  }

  return warnings;
}

function checkNpmVersions(filePath: string): string[] {
  const warnings: string[] = [];
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return warnings;
  }

  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; };
  try {
    pkg = JSON.parse(content);
  } catch {
    return warnings;
  }

  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const [name, versionSpec] of Object.entries(allDeps)) {
    if (name.startsWith('@opencode-ai/')) continue;

    const version = versionSpec.replace(/^[\^~>=<]*/g, '');
    if (!version || version === 'latest' || version === '*') continue;

    const cacheKey = `npm:${name}`;
    if (checkedThisSession.has(cacheKey)) continue;
    checkedThisSession.add(cacheKey);

    try {
      const result = spawnSync('npm', ['view', name, 'version'], {
        timeout: 10000,
        encoding: 'utf-8',
      });
      if (result.status === 0 && result.stdout) {
        const latest = result.stdout.trim();
        if (latest !== version) {
          warnings.push(`OUTDATED: ${name} ${version} -> latest is ${latest}`);
        } else {
          warnings.push(`OK: ${name} ${version} is latest`);
        }
      }
    } catch {
      warnings.push(`SKIP: Could not check ${name} ${version} (network/timeout)`);
    }
  }

  return warnings;
}

function checkCargoVersions(filePath: string): string[] {
  const warnings: string[] = [];
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return warnings;
  }

  const depRegex = /^(\w[\w-]*)\s*=\s*(?:"([^"]+)"|{[^}]*version\s*=\s*"([^"]+)")/gm;
  let inDeps = false;
  for (const line of content.split('\n')) {
    if (/^\[.*dependencies.*\]/.test(line)) {
      inDeps = true;
      continue;
    }
    if (/^\[/.test(line)) {
      inDeps = false;
      continue;
    }
    if (!inDeps) continue;

    const m = line.match(/^(\w[\w-]*)\s*=\s*(?:"([^"]+)"|{[^}]*version\s*=\s*"([^"]+)")/);
    if (!m) continue;

    const name = m[1];
    const version = (m[2] || m[3]).replace(/^[\^~>=<]*/g, '');
    const cacheKey = `cargo:${name}`;
    if (checkedThisSession.has(cacheKey)) continue;
    checkedThisSession.add(cacheKey);

    try {
      const result = spawnSync('cargo', ['search', name, '--limit', '1'], {
        timeout: 10000,
        encoding: 'utf-8',
      });
      if (result.status === 0 && result.stdout) {
        const m2 = result.stdout.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"`));
        if (m2) {
          const latest = m2[1];
          if (latest !== version) {
            warnings.push(`OUTDATED: ${name} ${version} -> latest is ${latest}`);
          } else {
            warnings.push(`OK: ${name} ${version} is latest`);
          }
        }
      }
    } catch {
      warnings.push(`SKIP: Could not check ${name} ${version} (network/timeout)`);
    }
  }

  return warnings;
}

export default async function versionPolice(ctx: PluginInput) {
  return {
    'tool.execute.after': async (
      input: { tool: string; sessionID: string; callID: string; },
      output: { title: string; output: string; metadata: unknown; },
    ) => {
      const toolName = input.tool?.toLowerCase();
      if (toolName !== 'edit' && toolName !== 'write') return;

      const relativePath = output.title;
      if (!relativePath) return;

      const absPath = path.isAbsolute(relativePath)
        ? relativePath
        : path.resolve(ctx.worktree, relativePath);

      let warnings: string[] = [];

      if (HELM_CHART_FILE.test(relativePath)) {
        warnings = checkHelmVersions(absPath);
      } else if (PACKAGE_JSON_FILE.test(relativePath)) {
        warnings = checkNpmVersions(absPath);
      } else if (CARGO_TOML_FILE.test(relativePath)) {
        warnings = checkCargoVersions(absPath);
      }

      if (warnings.length > 0) {
        output.output += `\n\nDEPENDENCY VERSION CHECK\n${
          warnings.map((w) => `  ${w}`).join('\n')
        }\n\nIf any dependency is OUTDATED, you MUST update it to the latest version before proceeding. Do NOT use outdated versions from your training data.`;
      }
    },
  };
}

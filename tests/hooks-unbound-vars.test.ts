import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Every police hook runs under `set -u`. A rule that reads a variable nothing
 * assigns does not fail loudly. git-police's attribution rule piped the read
 * into grep, so only the pipeline's subshell died: grep saw nothing, the test
 * was false, and that one rule never fired while the rest of the hook ran on.
 * It shipped that way twice (`$TOOL_INPUT`, then `$INPUT`) because the rule only
 * executes for a commit or a forge write, and no test reached the line. Nothing in
 * CI runs shellcheck, so this is the repository's own SC2154: an upper-case
 * variable read without a default must be assigned by the hook or by a library
 * it can source, or be guarded with a default form somewhere in the same file.
 */
const repoRoot = dirname(import.meta.dir);

const SHELL_PROVIDED = new Set([
  'HOME', 'PATH', 'PWD', 'OLDPWD', 'USER', 'TMPDIR', 'BASH_SOURCE', 'BASH_REMATCH', 'BASH_VERSION',
  'BASH_VERSINFO', 'FUNCNAME', 'LINENO', 'IFS', 'RANDOM', 'SECONDS', 'OSTYPE', 'HOSTNAME', 'SHELL',
  'EUID', 'UID', 'PIPESTATUS', 'OPTARG', 'OPTIND', 'REPLY', 'PPID', 'LANG', 'LC_ALL', 'TERM',
]);

// Comments and single-quoted strings expand nothing; a jq or awk program in
// single quotes would otherwise read as shell references.
function expandable(src: string): string {
  return src
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
    .join('\n')
    .replace(/'[^'\n]*'/g, "''");
}

export function assignedNames(src: string): Set<string> {
  const out = new Set<string>();
  const s = expandable(src);
  const decl = String.raw`(?:export|local|declare|readonly|typeset)\s+(?:-\w+\s+)*`;
  for (const m of s.matchAll(new RegExp(String.raw`(?:^|[\s;(&|])(?:${decl})?([A-Z][A-Z0-9_]*)(?:\+?=|\[)`, 'g'))) out.add(m[1]!);
  for (const m of s.matchAll(new RegExp(String.raw`\b${decl}((?:[A-Z][A-Z0-9_]*\s*)+)`, 'g'))) {
    for (const name of m[1]!.trim().split(/\s+/)) out.add(name);
  }
  for (const m of s.matchAll(/\bfor\s+([A-Z][A-Z0-9_]*)\s+in\b/g)) out.add(m[1]!);
  for (const m of s.matchAll(/\bprintf\s+-v\s+([A-Z][A-Z0-9_]*)/g)) out.add(m[1]!);
  for (const m of s.matchAll(/\b(?:read|mapfile|readarray)\b([^\n;|<]*)/g)) {
    for (const token of m[1]!.trim().split(/\s+/)) if (/^[A-Z][A-Z0-9_]*$/.test(token)) out.add(token);
  }
  return out;
}

export function guardedNames(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of expandable(src).matchAll(/\$\{([A-Z][A-Z0-9_]*)(?::?[-+=?]|\[[@*]\][-+])/g)) out.add(m[1]!);
  return out;
}

export function unguardedReads(src: string): Map<string, number> {
  const out = new Map<string, number>();
  expandable(src).split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/\$\{?([A-Z][A-Z0-9_]*)/g)) {
      const after = line.slice(m.index! + m[0].length);
      if (m[0].startsWith('${') && /^(?::?[-+=?]|\[[@*]\][-+])/.test(after)) continue;
      if (!out.has(m[1]!)) out.set(m[1]!, i + 1);
    }
  });
  return out;
}

export function unboundReads(src: string, librarySources: string[]): string[] {
  const known = new Set([...assignedNames(src), ...guardedNames(src)]);
  for (const lib of librarySources) for (const name of assignedNames(lib)) known.add(name);
  const findings: string[] = [];
  for (const [name, line] of unguardedReads(src)) {
    if (!SHELL_PROVIDED.has(name) && !known.has(name)) findings.push(`line ${line}: $${name}`);
  }
  return findings;
}

function shellFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sh')).map((f) => join(dir, f)) : [];
}

describe('no hook reads a variable that nothing assigns', () => {
  // The checker is the guard, so it has to be shown to bite: a guard that
  // quietly stopped matching would pass every hook forever.
  test('the checker flags the read that shipped, and clears it once it is guarded or assigned', () => {
    const shipped = 'set -euo pipefail\nCOMMAND=$(cat)\nif echo "$INPUT" | grep -q x; then exit 2; fi\n';
    expect(unboundReads(shipped, [])).toEqual(['line 3: $INPUT']);
    expect(unboundReads(shipped.replace('$INPUT', '$TOOL_INPUT'), [])).toEqual(['line 3: $TOOL_INPUT']);
    expect(unboundReads(shipped.replace('"$INPUT"', '"${INPUT:-}"'), [])).toEqual([]);
    expect(unboundReads(shipped, ['agentkit_slurp() { INPUT=$(cat); }\n'])).toEqual([]);
    expect(unboundReads('read -r MODE TYPE _ NAME <<<"$ENTRY"\necho "$TYPE $NAME"\n', [])).toEqual(['line 1: $ENTRY']);
    expect(unboundReads("jq -r '.x as $FOO | $FOO'\n", [])).toEqual([]);
  });

  for (const harness of ['claude', 'codex']) {
    const dir = join(repoRoot, 'hooks', harness);
    const libs = shellFiles(join(dir, 'lib'));
    const librarySources = libs.map((f) => readFileSync(f, 'utf8'));
    for (const file of [...shellFiles(dir), ...libs]) {
      test(`${file.slice(repoRoot.length + 1)}`, () => {
        expect(unboundReads(readFileSync(file, 'utf8'), librarySources)).toEqual([]);
      });
    }
  }
});

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The taste config moved under the brain banner. A refusal that still names the
// old key tells the reader to edit something that no longer exists, and doing
// what it says would not work — the failure is silent, because the config parses
// fine and simply binds nothing.
const repoRoot = join(import.meta.dir, '..', '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.(ts|sh|md)$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe('the taste config key path', () => {
  test('no shipped file names the pre-banner key', () => {
    const offenders: string[] = [];
    for (const dir of ['skills/taste', 'hooks/claude', 'plugins']) {
      for (const file of sources(join(repoRoot, dir))) {
        const text = readFileSync(file, 'utf-8');
        // `brain.taste.sources` contains `taste.sources`, so match only where it
        // is NOT already under the banner.
        for (const match of text.matchAll(/(^|[^.\w])taste\.(enabled|learning|sources)\b/g)) {
          const line = text.slice(0, match.index).split('\n').length;
          offenders.push(`${file.replace(repoRoot + '/', '')}:${line}`);
        }
      }
    }
    expect(offenders, `these still name the old key: ${offenders.join(', ')}`).toEqual([]);
  });

  test('the config example nests both units under the banner', () => {
    const example = readFileSync(join(repoRoot, 'config.example.yaml'), 'utf-8');
    expect(example).toContain('brain:');
    expect(example).not.toMatch(/^taste:/m);
  });
});

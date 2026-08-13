// Emits the version list the picker renders from, and the spare-list that
// keeps published archives out of the deploy's prune.
//
// Candidates come from data/archives.json, not from git tags: archives are
// never rebuilt, so a tag whose tree was never published would put a 404 in
// the picker.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Version {
  slug: string;
  label: string;
  current: boolean;
}

interface Parsed {
  slug: string;
  major: number;
  minor: number;
  patch: number;
}

export function parse(slugs: string[]): Parsed[] {
  const out: Parsed[] = [];
  for (const raw of slugs) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
    if (!match) continue;
    out.push({
      slug: `${match[1]}.${match[2]}.${match[3]}`,
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
    });
  }
  return out.sort((a, b) => b.major - a.major || b.minor - a.minor || b.patch - a.patch);
}

/** The last published patch of every minor older than the one shipping now. */
export function archivesFor(current: string, published: string[]): Parsed[] {
  const now = parse([current])[0];
  if (!now) return [];
  const seen = new Set<string>([`${now.major}.${now.minor}`]);
  const kept: Parsed[] = [];
  for (const entry of parse(published)) {
    const series = `${entry.major}.${entry.minor}`;
    if (seen.has(series)) continue;
    seen.add(series);
    kept.push(entry);
  }
  return kept;
}

export function versionList(current: string, published: string[]): Version[] {
  const now = parse([current])[0];
  if (!now) return [];
  return [
    { slug: now.slug, label: `v${now.slug} (latest)`, current: true },
    ...archivesFor(current, published).map((e) => ({
      slug: e.slug,
      label: `v${e.slug}`,
      current: false,
    })),
  ];
}

if (import.meta.main) {
  const here = import.meta.dir;
  const dataDir = join(here, '..', 'data');
  const current = new TextDecoder()
    .decode(Bun.spawnSync(['git', 'describe', '--tags', '--abbrev=0']).stdout)
    .trim();
  if (!current) {
    console.error('versions: no tag to name the current docs');
    process.exit(1);
  }
  const published: string[] = JSON.parse(readFileSync(join(dataDir, 'archives.json'), 'utf8')).published;
  const versions = versionList(current, published);
  if (versions.length === 0) {
    console.error(`versions: ${current} is not a version this script understands`);
    process.exit(1);
  }
  writeFileSync(join(dataDir, 'versions.json'), `${JSON.stringify(versions, null, 2)}\n`);
  writeFileSync(
    join(here, '..', 'archives.txt'),
    `${versions.slice(1).map((v) => v.slug).join('\n')}\n`,
  );
  console.log(
    `versions: current ${current}, archives ${versions.slice(1).map((v) => v.slug).join(', ') || '(none)'}`,
  );
}

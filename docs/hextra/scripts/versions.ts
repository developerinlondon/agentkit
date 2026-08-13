// Emits the version list the picker renders from, and the spare-list that
// keeps published archives out of the deploy's prune.
//
// Archives are never rebuilt: they are the bytes published when that version
// shipped, and tags older than this site carry the Astro one instead, so a
// rebuild from today's tree would falsify them.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Version {
  slug: string;
  tag: string;
  label: string;
  path: string;
}

interface Parsed {
  tag: string;
  major: number;
  minor: number;
  patch: number;
}

export function parseTags(tags: string[]): Parsed[] {
  const out: Parsed[] = [];
  for (const tag of tags) {
    const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
    if (!match) continue;
    out.push({
      tag: tag.trim(),
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
    });
  }
  return out.sort((a, b) => b.major - a.major || b.minor - a.minor || b.patch - a.patch);
}

/** The newest tag, plus the last patch of every earlier minor. */
export function select(tags: string[]): { current: Parsed; archives: Parsed[] } | null {
  const parsed = parseTags(tags);
  const current = parsed[0];
  if (!current) return null;

  const seen = new Set<string>([`${current.major}.${current.minor}`]);
  const archives: Parsed[] = [];
  for (const entry of parsed) {
    const series = `${entry.major}.${entry.minor}`;
    if (seen.has(series)) continue;
    seen.add(series);
    archives.push(entry);
  }
  return { current, archives };
}

function slugOf(entry: Parsed): string {
  return `${entry.major}.${entry.minor}.${entry.patch}`;
}

export function versionList(tags: string[]): Version[] {
  const picked = select(tags);
  if (!picked) return [];
  const list: Version[] = [{
    slug: slugOf(picked.current),
    tag: picked.current.tag,
    label: `${picked.current.tag} (latest)`,
    path: '/docs/',
  }];
  for (const entry of picked.archives) {
    list.push({
      slug: slugOf(entry),
      tag: entry.tag,
      label: entry.tag,
      path: `/docs/${slugOf(entry)}/`,
    });
  }
  return list;
}

if (import.meta.main) {
  const tags = new TextDecoder()
    .decode(Bun.spawnSync(['git', 'tag', '-l', 'v*', '--sort=-v:refname']).stdout)
    .split('\n')
    .filter(Boolean);
  const versions = versionList(tags);
  if (versions.length === 0) {
    console.error('versions: no v* tags found — the picker would offer nothing');
    process.exit(1);
  }
  const here = import.meta.dir;
  writeFileSync(join(here, '..', 'data', 'versions.json'), `${JSON.stringify(versions, null, 2)}\n`);
  // The deploy spares exactly these slugs from its prune; the current version
  // is not among them because this build produces it.
  writeFileSync(
    join(here, '..', 'archives.txt'),
    versions.slice(1).map((v) => v.slug).join('\n') + '\n',
  );
  console.log(`versions: current ${versions[0]?.tag}, archives ${versions.slice(1).map((v) => v.tag).join(', ') || '(none)'}`);
}

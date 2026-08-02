import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderThemed } from '../../skills/publish-page/render-html.ts';

const repo = join(import.meta.dir, '..', '..');
const source = join(repo, 'docs/site/examples/publish-freshness-deck.md');
const published = join(repo, 'docs/site/public/examples/publish-freshness-deck.html');
const cookbook = join(repo, 'docs/site/src/content/docs/cookbook/publish-a-page.md');

const SOURCE_PATH = 'docs/site/examples/publish-freshness-deck.md';

// Read from the paragraph a reader follows rather than hardcoded, because
// anything the sentence states and the guard assumes can drift apart silently:
// the title did exactly that, and the template and the link can too.
function documented(): { title: string; template: string; link: string } {
  const prose = readFileSync(cookbook, 'utf8');
  // Scoped to the deck's own paragraph — the page documents other templates and
  // other --title examples, and an unanchored match binds to one of those.
  const from = prose.indexOf('A rendered deck is worth more');
  if (from < 0) throw new Error(`no line opening "A rendered deck is worth more" in ${cookbook}`);
  const to = prose.indexOf('## Callouts', from);
  if (to < 0) throw new Error(`no "## Callouts" heading after that line in ${cookbook}`);
  const para = prose.slice(from, to);
  const title = para.match(/--title "([^"]+)"/);
  const template = para.match(/through the `([a-z]+)` template/);
  const link = para.match(/\]\((https?:\/\/[^)]+)\)/);
  if (!title) throw new Error('the cookbook no longer documents a --title for the example deck');
  if (!template) throw new Error('the cookbook no longer documents which template the example uses');
  if (!link) throw new Error('the cookbook no longer links the example deck source');
  return { title: title[1] as string, template: template[1] as string, link: link[1] as string };
}

describe('the published example deck', () => {
  // The deck is a committed render, so a theme change leaves it serving
  // superseded CSS with nothing to notice — the defect the deck itself is
  // about, reintroduced as a build artifact. The cookbook promises the
  // re-render reproduces it; this is what makes that a fact.
  test('re-renders byte-for-byte by following the cookbook', async () => {
    const { title, template } = documented();
    const rendered = await renderThemed({
      source: readFileSync(source, 'utf8'),
      isMd: true,
      template,
      title,
      themePath: join(repo, 'skills/publish-page/themes/deck.html'),
    });
    const then = 'stale example: re-render it through skills/publish-page/render-html.ts and commit the result';
    expect({ matches: rendered === readFileSync(published, 'utf8'), then })
      .toEqual({ matches: true, then });
  });

  test('the source the cookbook links is the source it was rendered from', () => {
    // The render above proves the title and the template; the link is the one
    // documented thing a reader can follow away from the file under test.
    const then = `point the link at ${SOURCE_PATH}, which is the file this guard renders`;
    expect({ linksTheSource: documented().link.endsWith(SOURCE_PATH), then })
      .toEqual({ linksTheSource: true, then });
  });
});

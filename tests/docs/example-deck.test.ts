import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderThemed } from '../../skills/publish-page/render-html.ts';

const repo = join(import.meta.dir, '..', '..');
const source = join(repo, 'docs/site/examples/publish-freshness-deck.md');
const published = join(repo, 'docs/site/public/examples/publish-freshness-deck.html');
const cookbook = join(repo, 'docs/site/src/content/docs/cookbook/publish-a-page.md');

// Taken from the sentence a reader follows, not hardcoded: a deck's cover
// headline is HTML, so publish.ts can derive no title from the source and the
// render only reproduces when the documented --title is the one given.
function documentedTitle(): string {
  // Anchored on the deck's own paragraph: the page documents other --title
  // examples earlier, and the first match in the file is one of those.
  const prose = readFileSync(cookbook, 'utf8');
  const at = prose.indexOf('publish-freshness-deck.md');
  if (at < 0) throw new Error('the cookbook no longer points at the example deck source');
  const found = prose.slice(at).match(/--title "([^"]+)"/);
  if (!found) throw new Error('the cookbook no longer documents a --title for the example deck');
  return found[1] as string;
}

describe('the published example deck', () => {
  // The deck is a committed render, so a theme change leaves it serving
  // superseded CSS with nothing to notice — the defect the deck itself is
  // about, reintroduced as a build artifact. The cookbook promises the
  // re-render reproduces it; this is what makes that a fact.
  test('re-renders byte-for-byte by following the cookbook', async () => {
    const rendered = await renderThemed({
      source: readFileSync(source, 'utf8'),
      isMd: true,
      template: 'deck',
      title: documentedTitle(),
      themePath: join(repo, 'skills/publish-page/themes/deck.html'),
    });
    const then = 'stale example: re-render it through skills/publish-page/render-html.ts and commit the result';
    expect({ matches: rendered === readFileSync(published, 'utf8'), then })
      .toEqual({ matches: true, then });
  });
});

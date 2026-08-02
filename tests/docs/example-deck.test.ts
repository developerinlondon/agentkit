import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderThemed } from '../../skills/publish-page/render-html.ts';

const repo = join(import.meta.dir, '..', '..');
const source = join(repo, 'docs/site/examples/publish-freshness-deck.md');
const published = join(repo, 'docs/site/public/examples/publish-freshness-deck.html');

describe('the published example deck', () => {
  // The deck is a committed render, so a theme change leaves it serving
  // superseded CSS with nothing to notice — the defect the deck itself is
  // about, reintroduced as a build artifact. The cookbook promises the
  // re-render reproduces it; this is what makes that a fact.
  test('re-renders byte-for-byte from its committed source', async () => {
    const rendered = await renderThemed({
      source: readFileSync(source, 'utf8'),
      isMd: true,
      template: 'deck',
      title: 'The Publish Freshness Architecture',
      themePath: join(repo, 'skills/publish-page/themes/deck.html'),
    });
    const then = 'stale example: re-render it through skills/publish-page/render-html.ts and commit the result';
    expect({ matches: rendered === readFileSync(published, 'utf8'), then })
      .toEqual({ matches: true, then });
  });
});

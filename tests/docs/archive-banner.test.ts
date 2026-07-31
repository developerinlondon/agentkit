import { describe, expect, test } from 'bun:test';
import {
  BANNER_MARKER,
  bannerHtml,
  injectBanner,
} from '../../docs/site/src/lib/archive-banner.ts';
import { GET } from '../../docs/site/src/pages/versions.json.ts';

const page = (body = '<main>archived page</main>') =>
  `<!DOCTYPE html><html lang="en"><head><title>Old</title></head><body class="page">${body}</body></html>`;

// An archive is its tag's own build, so its chrome predates the version picker
// and strands the reader. The banner is added after the build; everything here
// is about it landing exactly once and carrying a way out even when nothing
// else on the page works.
describe('the archive banner is injected into a built page', () => {
  test('the banner lands immediately inside body, ahead of the archive chrome', () => {
    const result = injectBanner(page(), '0.5.3');
    expect(result.injected).toBe(true);
    expect(result.html).toContain(`<body class="page">${BANNER_MARKER}`);
    expect(result.html.indexOf(BANNER_MARKER)).toBeLessThan(result.html.indexOf('<main>'));
  });

  test('the version being read is named in prose, not only in a control', () => {
    expect(injectBanner(page(), '0.5.3').html).toContain(
      'You are viewing the v0.5.3 documentation',
    );
  });

  // The select is built only once the version list arrives. Without this link a
  // failed fetch, a cached miss or disabled scripting leaves a dead end.
  test('a way back to the current docs is server-rendered, not scripted', () => {
    const { html } = injectBanner(page(), '0.5.3');
    expect(html).toContain('href="/docs/"');
    expect(html).toContain('Back to the latest documentation');
  });

  test('the archive names itself so the script can preselect it', () => {
    expect(injectBanner(page(), '0.4.5').html).toContain('data-slug="0.4.5"');
  });

  // Re-running the builder over an existing dist is routine; a second banner
  // would stack and push the page down twice.
  test('a second run over an injected page changes nothing', () => {
    const once = injectBanner(page(), '0.5.3').html;
    const twice = injectBanner(once, '0.5.3');
    expect(twice.injected).toBe(false);
    expect(twice.reason).toBe('already-present');
    expect(twice.html).toBe(once);
    expect(twice.html.split(BANNER_MARKER)).toHaveLength(2);
  });

  test('injecting a page built by a different slug still refuses to stack', () => {
    const once = injectBanner(page(), '0.5.3').html;
    expect(injectBanner(once, '0.4.5').injected).toBe(false);
  });

  test.each([
    ['no body at all', '<html><head></head></html>'],
    ['an empty document', ''],
  ])('%s is reported rather than silently skipped', (_label, html) => {
    const result = injectBanner(html, '0.5.3');
    expect(result.injected).toBe(false);
    expect(result.reason).toBe('no-body');
    expect(result.html).toBe(html);
  });

  test('body attributes on the archive survive the injection', () => {
    const html = '<html><body data-theme="dark" class="x"><p>hi</p></body></html>';
    expect(injectBanner(html, '0.5.3').html).toContain('<body data-theme="dark" class="x">');
  });

  // The slug reaches both an attribute and page text; a build that fed it
  // something quoted would otherwise close the tag early.
  test('a slug carrying markup cannot break out of the banner', () => {
    const html = bannerHtml('0.5"><script>alert(1)</script>');
    expect(html).not.toContain('"><script>alert(1)');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  test('the banner brings its own styling and behaviour, fetching nothing', () => {
    const html = bannerHtml('0.5.3');
    expect(html).toContain('<style>');
    expect(html).toContain('<script>');
    expect(html).not.toMatch(/(src|href)="https?:/);
    expect(html).not.toContain('<link');
  });
});

// The banner is only as good as the list it reads; an archive cannot know which
// releases followed it, so the current build has to publish one.
describe('the current build publishes the version list', () => {
  test('the endpoint answers with the same options the picker renders', async () => {
    const body = await (GET as (context: unknown) => Response)({}).json();
    expect(Array.isArray(body.versions)).toBe(true);
    expect(body.versions[0].path).toBe('/docs/');
    expect(body.versions[0].label).toContain('latest');
    for (const { label, path } of body.versions) {
      expect(typeof label).toBe('string');
      expect(path).toMatch(/^\/docs\/([0-9][0-9.]*\/)?$/);
    }
  });

  test('it is JSON, because the banner parses it in a browser', async () => {
    const response = (GET as (context: unknown) => Response)({});
    expect(response.headers.get('content-type')).toContain('application/json');
  });
});

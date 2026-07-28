import { Glob } from 'bun';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderDeck } from '../../skills/product-intelligence/scripts/render.ts';
import { splitSlides } from '../../skills/publish-page/slides.ts';
import {
  claim,
  FIELDS,
  hostileBrief,
  hostileLedger,
  journalBrief,
  ledgerWith,
  marker,
  minimalBrief,
  payload,
  src,
} from './fixtures.ts';

const repoRoot = dirname(dirname(import.meta.dir));
const skillRoot = join(repoRoot, 'skills', 'product-intelligence');
const mixed = join(skillRoot, 'examples', 'mixed');

let scratch = '';
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'agentkit-deck-'));
});
afterEach(() => {
  rmSync(scratch, { force: true, recursive: true });
});

// The publisher's own splitter, not a copy of it: a local one that agreed
// today is how a deck ships reading correctly under a rule the publisher does
// not apply.
function slides(md: string): string[] {
  return splitSlides(md).map((s) => s.trim());
}

function count(haystack: string, needle: RegExp): number {
  return (haystack.match(needle) ?? []).length;
}

describe('renderDeck', () => {
  const deck = () => renderDeck(mixed);

  function withArtifacts(brief: string, ledger?: string): string {
    writeFileSync(join(scratch, 'brief.yaml'), brief);
    writeFileSync(
      join(scratch, 'ledger.yaml'),
      ledger ?? readFileSync(join(skillRoot, 'schemas', 'fixtures', 'valid', 'ledger.yaml'), 'utf-8'),
    );
    return renderDeck(scratch);
  }

  function withFindings(...lines: string[]): string {
    writeFileSync(join(scratch, 'findings.md'), lines.join('\n'));
    return withArtifacts(journalBrief());
  }

  const section = (out: string, heading: string) => slides(out).find((s) => s.includes(heading))!;

  test('the title slide carries the full cover anatomy', () => {
    const [cover] = slides(deck());
    expect(cover).toStartWith('<div class="cover">');
    expect(cover).toContain('<div class="kicker">evidence brief — 2026-07-27</div>');
    // Two-tone headline: the subject in ink, the deck's fixed clause in accent.
    expect(cover).toContain('<h1>acme-notes. <span class="hi">What the evidence says.</span></h1>');
    expect(cover).toContain('<p class="thesis">Note-taking app that keeps every note');
    expect(cover).toContain('<div class="stats">');
  });

  // `.cover` opens a deck and may close it as a restatement; a middle one reads
  // as a second title slide and resets the reader's place.
  test('no slide after the first opens a cover', () => {
    for (const [i, slide] of slides(deck()).entries()) {
      if (i > 0) expect(slide, `slide ${i}`).not.toContain('class="cover"');
    }
  });

  test('a deck has no document heading to stack above the cover', () => {
    expect(deck()).not.toMatch(/^# /m);
  });

  // One idea per slide: a kicker, one h2, then the shape. A second h2 is a
  // second idea that the reader meets with no title.
  test('every slide after the cover has one kicker and exactly one h2', () => {
    const [, ...rest] = slides(deck());
    for (const slide of rest) {
      expect(count(slide, /^<div class="kicker">/gm), slide.slice(0, 60)).toBe(1);
      expect(count(slide, /^## /gm), slide.slice(0, 60)).toBe(1);
    }
  });

  test('the stat row caps at four numerals and paints at most one', () => {
    const [cover] = slides(deck());
    expect(count(cover, /<div class="stat[ "]/g)).toBeLessThanOrEqual(4);
    expect(count(cover, /class="stat hot"/g)).toBe(1);
    // The mixed example carries one contradiction; a stat with no label is a
    // hole in the row.
    expect(cover).toContain('<div class="lbl">contradiction</div>');
    expect(cover).not.toMatch(/<div class="lbl"><\/div>/);
  });

  // The conflict count is the ledger's whole reason to exist: a fourth class
  // label must never push it off the row.
  test('contradictions outrank the class breakdown for the fourth column', () => {
    const out = withArtifacts(
      minimalBrief(''),
      ledgerWith(
        [...claim('C-001', 'a', 'observed', 'high'), '    contradicts: [C-002]'],
        claim('C-002', 'b', 'inferred', 'moderate'),
        claim('C-003', 'c', 'proposed', 'low'),
        claim('C-004', 'd', 'unverified', 'low'),
      ),
    );
    const [cover] = slides(out);
    expect(cover).toContain('<div class="lbl">contradiction</div>');
    expect(count(cover, /<div class="stat[ "]/g)).toBe(4);
  });

  // Ids used to round-trip through a '|'-joined dedupe key, so an id carrying
  // one came back as two ids matching no claim and the rail crashed on it.
  test('a claim id containing the old dedupe delimiter still renders its pair', () => {
    const out = withArtifacts(
      minimalBrief(''),
      ledgerWith(
        [...claim('A|B', 'first side', 'observed', 'high'), '    contradicts: ["C|D"]'],
        claim('C|D', 'second side', 'observed', 'high'),
      ),
    );
    const rail = section(out, 'Unresolved contradictions');
    expect(rail).toContain('<strong>first side</strong> — versus second side');
    expect(rail).toContain('<span class="when">A&#124;B · C&#124;D</span>');
  });

  test('one claim and no conflicts reads in the singular with no empty cells', () => {
    const [cover] = slides(withArtifacts(minimalBrief(''), ledgerWith(claim('C-001', 'S.', 'observed', 'high'))));
    expect(cover).toContain('<div class="lbl">claim</div>');
    expect(cover).not.toContain('contradiction');
    expect(count(cover, /<div class="stat[ "]/g)).toBe(2);
  });

  test('an unclassed claim still counts but mints no blank label', () => {
    const [cover] = slides(withArtifacts(
      minimalBrief(''),
      ["ledger_version: '1.0'", 'claims:', '  - id: C-001', '    statement: s', '    confidence: high'].join('\n'),
    ));
    expect(cover).toContain('<div class="num">1</div>');
    expect(count(cover, /<div class="stat[ "]/g)).toBe(1);
  });

  test('a name already ending in punctuation does not grow a second stop', () => {
    const [cover] = slides(withArtifacts(minimalBrief('subject: { name: "acme?" }')));
    expect(cover).toContain('<h1>acme? <span class="hi">');
    expect(cover).not.toContain('acme?.');
  });

  // The theme numbers slides in the URL hash and rewrites it on navigation, so
  // a citation anchor is clobbered rather than followed.
  test('claim ids travel as text markers, never as links', () => {
    const out = deck();
    expect(out).not.toContain('href="#');
    expect(out).not.toContain('<sup>');
    expect(out).toContain('<span class="eyebrow">C-003</span>');
  });

  test('column cards stay within the four-column cap and label their count', () => {
    for (const slide of slides(deck())) {
      const cards = count(slide, /<div class="card">/g);
      if (cards === 0) continue;
      expect(cards, slide.slice(0, 60)).toBeLessThanOrEqual(4);
      const cols = slide.match(/<div class="cards( cols-(\d))?"/);
      expect(cols, slide.slice(0, 60)).not.toBeNull();
      if (cards >= 3) expect(Number(cols![2]), slide.slice(0, 60)).toBe(cards);
      else expect(cols![1] ?? '').toBe('');
    }
  });

  // Three groups of three beats a slide of three and a stranded single.
  test('cards group in threes, widening to four rather than stranding one', () => {
    const rows = (n: number) =>
      ['value_map:', ...Array.from({ length: n }, (_, i) => `  - { attribute: a${i}, value: v${i} }`)].join('\n');
    const counts = (n: number) =>
      slides(withArtifacts(minimalBrief(rows(n))))
        .filter((s) => s.includes('class="card"'))
        .map((s) => count(s, /<div class="card">/g));
    expect(counts(4)).toEqual([4]);
    expect(counts(7)).toEqual([4, 3]);
    expect(counts(6)).toEqual([3, 3]);
    expect(counts(9)).toEqual([3, 3, 3]);
    // Threes and fours both strand one here; a four up front absorbs it.
    expect(counts(13)).toEqual([4, 3, 3, 3]);
    expect(counts(25)).toEqual([4, 3, 3, 3, 3, 3, 3, 3]);
  });

  test('legend rails stay within the six-row cap', () => {
    const out = withArtifacts(
      minimalBrief([
        'workflows:',
        '  - name: long flow',
        '    steps:',
        ...Array.from({ length: 8 }, (_, i) => `      - { step: s${i}, description: d${i} }`),
      ].join('\n')),
    );
    for (const slide of slides(out).filter((s) => s.includes('<ul class="rails">'))) {
      expect(count(slide, /<li class="rail /g), slide.slice(0, 60)).toBeLessThanOrEqual(6);
    }
    // Eight steps spill onto a second slide rather than overflowing the first.
    const flow = slides(out).filter((s) => s.includes('## long flow'));
    expect(flow).toHaveLength(2);
    expect(count(flow[0], /<li class="rail /g)).toBe(6);
    expect(count(flow[1], /<li class="rail /g)).toBe(2);
  });

  // A legend decoding one colour explains nothing; two or more is a scale.
  test('the provenance legend appears only when it decodes more than one tone', () => {
    const both = slides(deck()).find((s) => s.includes('Where this came from'))!;
    expect(both).toContain('<div class="legend">');
    expect(count(both, /<span class="key /g)).toBeGreaterThan(1);
    const ledgerOnly = withArtifacts(
      ["brief_version: '1.0'", 'subject: { name: acme }', 'evidence: { ledger: ledger.yaml }'].join('\n'),
      ledgerWith(claim('C-001', 's', 'observed', 'high')),
    );
    const provenance = slides(ledgerOnly).find((s) => s.includes('Where this came from'))!;
    expect(provenance).toContain('<li class="rail dim">');
    expect(provenance).not.toContain('<div class="legend">');
  });

  // A legend is per slide, not per deck: the overflow slide carried the full
  // three-key legend above a single ledger row, decoding two absent colours.
  test('a provenance legend names only the tones on its own slide', () => {
    const out = withArtifacts([
      "brief_version: '1.0'",
      'subject: { name: acme, repo: r, homepage: h }',
      'evidence:',
      '  ledger: ledger.yaml',
      '  acquisition:',
      ...Array.from({ length: 5 }, (_, i) => `    - { tool: t${i}, target: g${i}, retrieved_at: "2026-07-28" }`),
    ].join('\n'));
    const provenance = slides(out).filter((s) => s.includes('Where this came from'));
    expect(provenance).toHaveLength(2);
    for (const slide of provenance) {
      const tones = new Set([...slide.matchAll(/<li class="rail (\w+)"/g)].map((m) => m[1]));
      const keys = new Set([...slide.matchAll(/<span class="key (\w+)"/g)].map((m) => m[1]));
      expect([...keys].sort(), slide.slice(0, 40)).toEqual(tones.size > 1 ? [...tones].sort() : []);
    }
  });

  test('no provenance slide is minted when there is nothing to trace', () => {
    const out = withArtifacts(
      ["brief_version: '1.0'", 'subject: { name: acme }', 'evidence: { ledger: ledger.yaml }'].join('\n'),
      ['claims:', ...claim('C-001', 's', 'observed', 'high')].join('\n'),
    );
    expect(out).not.toContain('Where this came from');
  });

  // A single-origin brief names its sources in subject.repo/homepage rather
  // than an origins list. Dropping them sent the reader back to the doc.
  test('repo and homepage reach provenance when no origins list is declared', () => {
    const provenance = slides(deck()).find((s) => s.includes('Where this came from'))!;
    expect(provenance).toContain('<span class="key hot">origin</span>');
    expect(provenance).toContain('<code>github.com/acme/acme-notes</code>');
    expect(provenance).toContain('acme-notes.example');
  });

  test('an explicit origins list wins over the plain fields', () => {
    const provenance = slides(withArtifacts([
      "brief_version: '1.0'",
      'subject:',
      '  name: acme',
      '  repo: github.com/acme/plain',
      '  origins:',
      '    - { id: kit, kind: repo, target: repo:../kit }',
      'evidence: { ledger: ledger.yaml }',
    ].join('\n'))).find((s) => s.includes('Where this came from'))!;
    expect(provenance).toContain('<strong>kit</strong> — repo <code>repo:../kit</code>');
    expect(provenance).not.toContain('plain');
  });

  // A transform that silently drops a brief section is not the brief.
  test('every authored brief section reaches a slide', () => {
    const out = deck();
    for (const heading of [
      'What it is',
      'What that gets you',
      "In a user&#39;s words",
      'capture a finding',
      'Public surface, page by page',
      'Unresolved contradictions',
      'What we could not verify',
      'Where this came from',
      'What the analyze pass flagged',
    ]) {
      expect(out, heading).toContain(`## ${heading}`);
    }
    // Every ledger claim gets its own evidence slide, kicked by its id.
    const ledger = readFileSync(join(mixed, 'ledger.yaml'), 'utf-8');
    for (const id of new Set(ledger.match(/C-\d{3}/g) ?? [])) {
      expect(out, id).toContain(`<div class="kicker">${id}</div>`);
    }
  });

  test('a workflow slide is titled by its own flow name', () => {
    const out = withArtifacts(minimalBrief([
      'workflows:',
      '  - name: first flow',
      '    steps: [{ step: s, description: d }]',
      '  - name: second flow',
      '    steps: [{ step: s, description: d }]',
    ].join('\n')));
    expect(out).toContain('## first flow');
    expect(out).toContain('## second flow');
    expect(out).toContain('<span class="when">s</span>');
  });

  test('a nameless or stepless workflow neither crashes nor mints an empty slide', () => {
    const out = withArtifacts(minimalBrief([
      'workflows:',
      '  - steps: [{ step: s, description: d }]',
      '  - name: empty',
    ].join('\n')));
    expect(out).toContain('## Where it sits in the work');
    expect(out).not.toContain('## empty');
  });

  test('a sourceless claim says so instead of showing an empty quote', () => {
    const out = deck();
    expect(out).toContain('this claim is proposed');
    expect(out).not.toMatch(/\n> \n/);
  });

  test('an uncited card says uncited rather than showing a blank eyebrow', () => {
    const out = withArtifacts(minimalBrief('value_map:\n  - { attribute: a, value: v }'));
    expect(out).toContain('<span class="eyebrow">uncited</span>');
    expect(out).not.toContain('<span class="eyebrow"></span>');
  });

  test('a minimal brief still renders a cover and its evidence', () => {
    copyFileSync(join(skillRoot, 'schemas', 'fixtures', 'valid', 'brief.minimal.yaml'), join(scratch, 'brief.yaml'));
    copyFileSync(join(skillRoot, 'schemas', 'fixtures', 'valid', 'ledger.yaml'), join(scratch, 'ledger.yaml'));
    const out = renderDeck(scratch);
    expect(out).toContain('<div class="cover">');
    expect(out).toContain('acme-notes');
    expect(out).not.toContain('## What that gets you');
  });

  test('a missing ledger fails with a clear message, not a stack', () => {
    writeFileSync(join(scratch, 'brief.yaml'), journalBrief());
    expect(() => renderDeck(scratch)).toThrow('render needs both');
  });

  // Every untrusted field, sampled one payload each: a field the table does not
  // name is one refactor away from silently losing its escaping.
  test('no untrusted field can inject markup, links or headings', () => {
    const out = withArtifacts(hostileBrief(), hostileLedger());
    expect(out).not.toContain('<script');
    expect(out).not.toContain('](javascript:');
    expect(out).not.toMatch(/^#+ forged/m);
    for (const field of FIELDS) {
      expect(out, `${field} unescaped`).not.toContain(`<script>${marker(field)}`);
      expect(out, `${field} missing`).toContain(`&lt;script&gt;${marker(field)}`);
    }
  });

  // Per SITE, not per field: a field reaching several sites is covered by
  // whichever one the sweep above happens to hit, so an escaper dropped at any
  // single site left the whole suite green.
  test.each([
    ['claim id in the slide kicker', /<div class="kicker">&lt;script&gt;claimid&lt;\/script&gt;/],
    ['contradiction rail statement', /<li class="rail red"><strong>&lt;script&gt;statement&lt;\/script&gt;/],
    ['contradiction rail counter-statement', /versus &lt;script&gt;statementb&lt;\/script&gt;/],
    ['contradiction rail ids', /<span class="when">&lt;script&gt;claimid&lt;\/script&gt;/],
    ['origin rail id', /<li class="rail hot"><strong>&lt;script&gt;originid&lt;\/script&gt;/],
    ['origin rail kind', /<\/strong> — &lt;script&gt;originkind&lt;\/script&gt;/],
    ['origin rail target', /<code>&lt;script&gt;origintarget&lt;\/script&gt;/],
    ['positioning claims chip', /<strong>claims<\/strong> &lt;script&gt;posclaims&lt;\/script&gt;/],
  ] as Array<[string, RegExp]>)('%s escapes at the site, not merely somewhere', (_site, at) => {
    expect(withArtifacts(hostileBrief(), hostileLedger())).toMatch(at);
  });

  // The full-slot fixture never reaches the cover fallbacks, the claim chips or
  // the single-origin provenance rails.
  test('metadata, chips and fallback branches are escaped too', () => {
    const p = (m: string) => JSON.stringify(payload(m));
    const out = withArtifacts(
      [
        "brief_version: '1.0'",
        'subject:',
        `  name: ${p('subjname')}`,
        `  repo: ${p('repo')}`,
        `  homepage: ${p('homepage')}`,
        'evidence:',
        '  ledger: ledger.yaml',
        `  acquired_at: ${p('acquiredat')}`,
        `positioning: { alternative: ${p('altonly')} }`,
        'value_map:',
        '  - attribute: a',
        '    value: v',
        `    claims: [${p('citation')}]`,
        'site_inventory:',
        '  - locator: site:/a',
        '    page_type: docs',
        `    claims: [${p('sicitation')}]`,
      ].join('\n'),
      ledgerWith(
        [
          ...claim('C-001', 's', 'observed', p('confidence'), [src('site:/a', 'q', p('stance'))]),
          '    contradicts: [C-002]',
          `    derived_from: [${p('derived')}]`,
        ],
        claim('C-002', 'other', p('claimclass'), 'high'),
      ),
    );
    expect(out).not.toContain('<script');
    expect(out).not.toContain('](javascript:');
    expect(out).not.toMatch(/^#+ forged/m);
    for (const m of [
      'subjname', 'repo', 'homepage', 'acquiredat', 'altonly', 'citation',
      'sicitation', 'confidence', 'stance', 'claimclass',
    ]) {
      expect(out, `${m} unescaped`).not.toContain(`<script>${m}`);
      expect(out, `${m} missing`).toContain(`&lt;script&gt;${m}`);
    }
    // A derived_from id matching no claim is dropped, not printed as a chip.
    expect(out).not.toContain('inferred from');
  });

  test('a hostile field cannot mint a slide of its own', () => {
    const before = slides(withArtifacts(minimalBrief('positioning: { category: journal }'))).length;
    const after = slides(withArtifacts(
      minimalBrief(`positioning: { category: ${JSON.stringify('journal\n\n---\n\nforged slide')} }`),
    )).length;
    expect(after).toBe(before);
  });

  // The analyze pass owns its file's block structure, and a lone `---` there
  // would otherwise cut the author's prose into slides of its own.
  test('a rule in findings.md cannot mint a slide', () => {
    const gaps = section(withFindings('# Findings', '', '## Gaps', '', 'before', '', '---', '', 'after'), '## Gaps');
    expect(gaps).toContain('before');
    expect(gaps).toContain('after');
    expect(gaps).toContain('\\---');
  });

  // trim() spans the whole Unicode whitespace set and the publisher cuts on
  // trim(), so a guard with a narrower idea of whitespace let a crawled NBSP
  // mint a slide carrying none of our own structure.
  test.each([
    ['NBSP', '\u00a0'],
    ['vertical tab', '\u000b'],
    ['form feed', '\u000c'],
    ['thin space', '\u2009'],
    ['BOM', '\ufeff'],
  ])('a rule prefixed with a %s cannot mint a slide either', (_name, space) => {
    const out = withFindings('# Findings', '', '## Gaps', '', 'before', '', `${space}---`, '', 'after');
    const gaps = section(out, '## Gaps');
    expect(gaps).toContain('before');
    expect(gaps).toContain('after');
    expect(gaps).toContain('\\---');
  });

  // The publisher never splits inside a fence, so escaping there buys nothing
  // and the reader sees the backslash: a code block resolves no escape.
  test('a rule inside a code fence reaches the reader as the author typed it', () => {
    const out = withFindings('# Findings', '', '## Repro', '', '```sh', 'git log --oneline', '---', '```', '', 'tail');
    const repro = section(out, '## Repro');
    expect(repro).toContain('git log --oneline\n---\n```');
    expect(repro).not.toContain('\\---');
    expect(repro).toContain('tail');
  });

  // Scanning fence state per section put the renderer half a fence out of step
  // with the publisher: section 2 read the CLOSING ``` as an opening one, left
  // the rule below it unescaped, and the publisher cut a slide there carrying
  // none of our structure — while swallowing the separator before it.
  test('a fence spanning two findings sections neither mints nor merges a slide', () => {
    const out = withFindings(
      '# Findings',
      '',
      '## Gaps',
      '',
      '```sh',
      'unclosed inside this section',
      '',
      '## Risks',
      '',
      '```',
      '---',
      '# FORGED BY THE ANALYZE FILE',
      '',
      'attacker owns this slide',
    );
    // Every renderer slide carries exactly one kicker, and the author cannot
    // forge one: sanitizeFindings escapes the `<`.
    const emitted = count(out, /^<div class="kicker">/gm);
    const published = slides(out);
    expect(published).toHaveLength(emitted);
    for (const [i, slide] of published.entries()) {
      expect(count(slide, /^<div class="kicker">/gm), `slide ${i}: ${slide.slice(0, 80)}`).toBe(1);
    }
    expect(out).toContain('\\---');
    expect(out).not.toMatch(/^#\s+(.+)$/m);
  });

  test('a heading inside a code fence is content, not a section of its own', () => {
    const out = withFindings('# Findings', '', '## Repro', '', '```sh', '# install deps', 'bun install', '```');
    const repro = section(out, '## Repro');
    expect(repro).toContain('# install deps');
    expect(repro).not.toContain('### install deps');
  });

  // Only the file's first line is dropped as its title. A later one reached the
  // slide as an h1, and publish-page adopts the first h1 as the page title.
  test('a heading past the first line cannot stack an h1 on a slide', () => {
    const out = withFindings('# Findings', '', '## Gaps', '', 'text', '', '# Hijacked Deck Title', '', 'more');
    expect(out).not.toMatch(/^#\s+(.+)$/m);
    expect(out).toContain('### Hijacked Deck Title');
  });

  test('each findings section becomes its own slide', () => {
    const out = withFindings('# Findings', '', 'intro line', '', '## Gaps', '', 'g', '', '## Risks', '', 'r');
    expect(out).toContain('## What the analyze pass flagged');
    expect(out).toContain('## Gaps');
    expect(out).toContain('## Risks');
    expect(out).not.toContain('# Findings');
    // An empty trailing section mints no blank slide.
    for (const slide of slides(out)) expect(slide).not.toMatch(/^<div class="kicker">[^\n]*<\/div>\n\n## [^\n]*$/);
  });

  test('raw HTML and link syntax in findings.md stay inert on a slide', () => {
    const slide = section(
      withFindings(
        '# Findings',
        '',
        '## Risks',
        '',
        '<script>alert(1)</script>',
        'Plain [click](javascript:alert(1)).',
        'Pre-escaped \\[c5\\](javascript:alert(1)).',
        'Bare https://evil.example and www.evil.example and a@evil.example.',
      ),
      '## Risks',
    );
    // Only what the analyze pass wrote is untrusted; the kicker and the h2
    // above it are ours, and their markup is not the author's to escape.
    const risks = slide.slice(slide.indexOf('## Risks') + '## Risks'.length);
    expect(risks).not.toContain('](javascript:');
    // Inert only when an ODD number of backslashes precedes the character.
    for (const m of risks.matchAll(/(\\*)([[\]()<])/g)) {
      expect(m[1].length % 2, `${m[2]} after ${m[1].length} backslashes`).toBe(1);
    }
    expect(risks).toContain('https\\://evil.example');
    expect(risks).toContain('www\\.evil.example');
    expect(risks).toContain('a\\@evil.example');
  });

  // marked's whole GFM autolink surface. A raw-HTML island cannot use a
  // backslash — it would display — so those fields entity-encode instead.
  test.each([
    'https://evil.example/x',
    'HTTP://evil.example/x',
    'FtP://evil.example/x',
    'www.evil.example',
    'foo.@evil.example',
  ])('no deck field turns %s into a link', (url) => {
    const out = withArtifacts(
      minimalBrief([
        `subject: { name: ${JSON.stringify(`n ${url}`)}, one_liner: ${JSON.stringify(`o ${url}`)} }`,
        'value_map:',
        `  - { attribute: ${JSON.stringify(`a ${url}`)}, value: v, proof: ${JSON.stringify(`p ${url}`)} }`,
      ].join('\n')),
      ledgerWith(claim('C-001', `s ${url}`, `observed ${url}`, `high ${url}`, [
        src('site:/a', `q ${url}`, 'supports'),
      ])),
    );
    for (const m of out.matchAll(/(https?|ftp):\/\//gi)) {
      expect(out.slice(Math.max(0, m.index - 1), m.index), `bare ${m[0]}`).toBe('\\');
    }
    expect(out).not.toMatch(/(?<![\\;])www\./i);
    expect(out).not.toMatch(/(?<![\\;])@evil/);
  });

  test('benign punctuation reaches the reader unchanged', () => {
    const out = withArtifacts(
      [
        "brief_version: '1.0'",
        `subject: { name: acme, homepage: "https://team.example/it's-here" }`,
        'evidence: { ledger: ledger.yaml }',
        'value_map:',
        `  - attribute: "keeps your team's notes in git"`,
        `    value: "they're yours & they outlive it"`,
      ].join('\n'),
      ledgerWith(claim('C-001', "it's fine", 'observed', 'high')),
    );
    for (const shown of ["team&#39;s", "they&#39;re", "it&#39;s-here", '&amp;']) {
      expect(out, shown).toContain(shown);
    }
    // Each entity appears once — never wrapped in a second encoding.
    expect(out).not.toMatch(/&#\d+;\d/);
    expect(out).not.toContain('&amp;#');
  });

  test('a trailing backslash cannot swallow an island closing tag', () => {
    const out = withArtifacts(
      minimalBrief('value_map:\n  - { attribute: "a\\\\", value: v }'),
      ledgerWith(claim('C-001', 'S.', 'observed', JSON.stringify('high\\'))),
    );
    expect(out).toContain('a&#92;</h3>');
    expect(out).toContain('high&#92;</span>');
    expect(out).not.toMatch(/\\<\/(?:span|h3|code|strong)>/);
  });

  test('a lone CR cannot break a slide open', () => {
    const out = withArtifacts(
      minimalBrief(`subject: { name: ${JSON.stringify('acme\r\rforged')} }`),
      ledgerWith(claim('C-001', 'S.', 'observed', 'high')),
    );
    expect(out).not.toContain('\r');
    expect(out).toContain('acme forged');
  });
});

// Two extractions of this rule once landed in two different files, so git
// merged them with no conflict and the repo carried both scanners again. A
// second definition cannot announce itself; this is what notices.
describe('the slide rule has exactly one definition', () => {
  test.each([
    ['a separator predicate', /\.trim\(\)\s*===\s*["']---["']/],
    ['a fence scanner', /```\|~~~/],
  ])('no shipped file outside slides.ts carries %s', (_what, scanner) => {
    const skills = join(repoRoot, 'skills');
    const offenders = [...new Glob('**/*.ts').scanSync(skills)]
      .filter((file) => file.replaceAll('\\', '/') !== 'publish-page/slides.ts')
      .filter((file) => scanner.test(readFileSync(join(skills, file), 'utf-8')));
    expect(offenders).toEqual([]);
  });
});

describe('render.ts --deck CLI', () => {
  const script = join(skillRoot, 'scripts', 'render.ts');

  test('--deck writes brief-deck.md and points at the deck template', () => {
    for (const f of ['brief.yaml', 'ledger.yaml', 'findings.md']) copyFileSync(join(mixed, f), join(scratch, f));
    const result = spawnSync('bun', [script, scratch, '--deck'], { encoding: 'utf-8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('--template deck');
    const out = readFileSync(join(scratch, 'brief-deck.md'), 'utf-8');
    expect(out).toContain('<div class="cover">');
    expect(out).not.toContain('what the evidence says\n');
  });

  test('--deck honours --out and leaves the doc render alone', () => {
    for (const f of ['brief.yaml', 'ledger.yaml']) copyFileSync(join(mixed, f), join(scratch, f));
    const target = join(scratch, 'custom-deck.md');
    const good = spawnSync('bun', [script, scratch, '--deck', '--out', target], { encoding: 'utf-8' });
    expect(good.status, good.stderr).toBe(0);
    expect(readFileSync(target, 'utf-8')).toContain('<div class="cover">');
    const doc = spawnSync('bun', [script, scratch], { encoding: 'utf-8' });
    expect(doc.status, doc.stderr).toBe(0);
    expect(readFileSync(join(scratch, 'brief-page.html'), 'utf-8'))
      .toContain('<h1>acme-notes: what the evidence says</h1>');
  });
});

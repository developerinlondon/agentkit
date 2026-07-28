import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderBrief } from '../../skills/product-intelligence/scripts/doc.ts';
import {
  claim,
  FIELDS,
  hostileBrief,
  HOSTILE_SHAPES,
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
  scratch = mkdtempSync(join(tmpdir(), 'agentkit-render-'));
});
afterEach(() => {
  rmSync(scratch, { force: true, recursive: true });
});

// The page is HTML the renderer emits and nothing parses it again, so the whole
// security question is one question: does any markup exist that this renderer
// did not write? Every tag and every attribute in the output must be one it
// chose, and every link must be a same-document citation.
const TAGS = new Set([
  'a', 'blockquote', 'br', 'code', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'li', 'ol', 'p', 'pre', 'span', 'strong', 'sup', 'table', 'tbody', 'td',
  'th', 'thead', 'tr', 'ul',
]);
const ATTRS = new Set(['class', 'href', 'id']);

// Asked of a real HTML parser, never a regex over the source: a scan of our own
// that disagreed with the browser would answer for a page nobody is served.
async function expectRendererMarkupOnly(html: string, label: string) {
  const tags = new Set<string>();
  const attrs = new Map<string, string>();
  const hrefs: string[] = [];
  const parsed = new HTMLRewriter().on('*', {
    element(el) {
      tags.add(el.tagName.toLowerCase());
      for (const [name, value] of el.attributes) {
        attrs.set(name.toLowerCase(), `<${el.tagName.toLowerCase()} ${name}="${value.slice(0, 60)}">`);
        if (name.toLowerCase() === 'href') hrefs.push(value);
      }
    },
  }).transform(new Response(html));
  await parsed.text();
  for (const tag of tags) expect(TAGS, `${label}: <${tag}>`).toContain(tag);
  for (const [attr, where] of attrs) expect(ATTRS, `${label}: ${where}`).toContain(attr);
  for (const href of hrefs) {
    expect(href.startsWith('#'), `${label}: href=${href.slice(0, 60)}`).toBe(true);
  }
}

describe('renderBrief', () => {
  const page = () => renderBrief(mixed);

  function withArtifacts(brief: string, ledger?: string): string {
    writeFileSync(join(scratch, 'brief.yaml'), brief);
    writeFileSync(
      join(scratch, 'ledger.yaml'),
      ledger ?? readFileSync(join(skillRoot, 'schemas', 'fixtures', 'valid', 'ledger.yaml'), 'utf-8'),
    );
    return renderBrief(scratch);
  }

  // Everything the analyze pass wrote lands after its heading; the section is
  // last, so only that span carries content the renderer did not compose.
  function findingsSection(out: string): string {
    const start = out.indexOf('<h2>What the analyze pass flagged</h2>');
    expect(start).toBeGreaterThan(-1);
    return out.slice(start);
  }

  function withFindings(...lines: string[]): string {
    writeFileSync(join(scratch, 'findings.md'), lines.join('\n'));
    return withArtifacts(journalBrief());
  }

  test('every ledger claim is anchored and every citation links to one', async () => {
    const out = page();
    const ledger = readFileSync(join(mixed, 'ledger.yaml'), 'utf-8');
    for (const id of ledger.match(/C-\d{3}/g) ?? []) {
      expect(out, id).toContain(`id="${id.toLowerCase()}"`);
    }
    for (const ref of out.match(/href="#(c-\d{3})"/g) ?? []) {
      const id = ref.match(/#(c-\d{3})/)![1];
      expect(out, ref).toContain(`id="${id}"`);
    }
  });

  test('positioning renders as a sentence, not yaml slots', async () => {
    const out = page();
    expect(out).toContain('<strong>For</strong> solo developers <strong>who need</strong>');
    expect(out).toContain('<strong>Unlike</strong> hosted note SaaS');
    expect(out).not.toContain('target_customer');
  });

  test('hostile quotes and fields cannot inject markup into the page', async () => {
    // Quotes are verbatim excerpts from crawled sources; the published page's
    // CSP permits inline script, so raw interpolation would be stored XSS.
    const out = withArtifacts(
      minimalBrief('positioning: { category: "<img src=x onerror=alert(1)>" }'),
      ledgerWith(claim('C-001', '<script>alert(1)</script>', 'observed', 'high', [
        src('site:/<script>x</script>', '</blockquote><script>alert(1)</script>', 'supports'),
      ])),
    );
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&lt;img');
    await expectRendererMarkupOnly(out, 'hostile quote');
  });

  test('a multi-line quote stays inside its blockquote', async () => {
    const out = withArtifacts(
      journalBrief(),
      ledgerWith(claim('C-001', 'multi-line source', 'observed', 'high', [
        src('site:/x', 'line one\n## Injected Heading\nline three', 'supports'),
      ])),
    );
    // The markers are text in an HTML paragraph — no heading can form from
    // them — and the source keeps the line structure it was written with.
    expect(out).toContain('<p>line one<br />## Injected Heading<br />line three</p>');
    expect(out).not.toContain('<h2>Injected Heading');
  });

  // The whole point of emitting HTML: markdown metacharacters are no longer
  // syntax, so a quote reaches the reader as the source wrote it instead of
  // wearing the backslashes that used to defuse it.
  test('markdown in a quote is inert and reaches the reader verbatim', async () => {
    const out = withArtifacts(
      journalBrief(),
      ledgerWith(claim('C-001', 'markdown quote', 'observed', 'high', [
        src('site:/pricing', 'Free plan: [claim your *free* seat](javascript:fetch(1))', 'supports'),
        src('site:/terms', 'Pay *only* $5 for 2*3 items -- see `config.yaml`', 'supports'),
      ])),
    );
    expect(out).toContain('Free plan: [claim your *free* seat](javascript:fetch(1))');
    expect(out).toContain('Pay *only* $5 for 2*3 items -- see `config.yaml`');
    expect(out).not.toContain('\\[');
    await expectRendererMarkupOnly(out, 'markdown quote');
  });

  test('no untrusted field can inject markup, an attribute or a link', async () => {
    const out = withArtifacts(hostileBrief(), hostileLedger());
    await expectRendererMarkupOnly(out, 'every field');
    for (const field of FIELDS) {
      expect(out, `${field} unescaped`).not.toContain(`<script>${marker(field)}`);
      expect(out, `${field} missing`).toContain(`&lt;script&gt;${marker(field)}`);
    }
  });

  // One payload shape per way markup can start, driven through every field: a
  // gap sampled in one shape and not another is a gap that ships.
  const SHAPE_EXPECTATION: Record<string, (m: string) => { shown: string; absent?: string }> = {
    tag: (m) => ({ shown: `&lt;script&gt;${m}`, absent: `<script>${m}` }),
    attribute: (m) => ({ shown: `data-${m}=&quot;`, absent: `onmouseover="alert(1)"` }),
    quote: (m) => ({ shown: `&#39;&gt;&lt;script&gt;${m}`, absent: `<script>${m}` }),
    // Already-encoded input is encoded again, so the reader sees the source
    // text rather than the tag it decodes to.
    entity: (m) => ({ shown: `&amp;lt;script&amp;gt;${m}`, absent: `&lt;script&gt;${m}` }),
    scheme: (m) => ({ shown: `javascript:alert(1)//${m}` }),
    // The fidelity promise: a backslash is a character, not an escape.
    backslash: (m) => ({ shown: `C:\\Users\\${m}\\` }),
  };

  test.each(Object.keys(HOSTILE_SHAPES))('every field stays inert under the %s payload', async (shape) => {
    const make = HOSTILE_SHAPES[shape];
    const out = withArtifacts(hostileBrief(make), hostileLedger(make));
    await expectRendererMarkupOnly(out, shape);
    for (const field of FIELDS) {
      const { shown, absent } = SHAPE_EXPECTATION[shape](marker(field));
      expect(out, `${field} missing`).toContain(shown);
      if (absent) expect(out, `${field} unescaped`).not.toContain(absent);
    }
  });

  // The full-slot fixture above never reaches the chips, the citation anchors,
  // the single-slot positioning fallbacks or the contradiction rows.
  test('metadata, citations and fallback branches are escaped too', async () => {
    const p = (m: string) => JSON.stringify(payload(m));
    const out = withArtifacts(
      [
        "brief_version: '1.0'",
        'subject:',
        `  name: ${p('subjname')}`,
        `  repo: ${p('repo')}`,
        `  homepage: ${p('homepage')}`,
        '  origins:',
        `    - { id: ${p('originone')} }`,
        `    - { id: ${p('origintwo')} }`,
        'evidence:',
        '  ledger: ledger.yaml',
        `  acquired_at: ${p('acquiredat')}`,
        `positioning: { alternative: ${p('altonly')} }`,
        'value_map:',
        '  - attribute: a',
        '    value: v',
        `    claims: [${p('citation')}]`,
      ].join('\n'),
      ledgerWith(
        [
          ...claim('C-001', payload('stmtone'), 'observed', 'high', [
            src('site:/a', 'q', 'supports'),
          ]),
          '    contradicts: [C-002]',
        ],
        claim('C-002', payload('stmttwo'), 'observed', 'high'),
      ),
    );
    await expectRendererMarkupOnly(out, 'metadata');
    for (const m of [
      'subjname', 'repo', 'homepage', 'originone', 'origintwo', 'acquiredat',
      'altonly', 'citation', 'stmtone', 'stmttwo',
    ]) {
      expect(out, `${m} unescaped`).not.toContain(`<script>${m}`);
      expect(out, `${m} missing`).toContain(`&lt;script&gt;${m}`);
    }
    // The citation reaches both the anchor target and its label.
    expect(out).toContain('href="#&lt;script&gt;citation&lt;/script&gt;[x](javascript:alert(1))');
  });

  // renderBrief validates nothing, so schema-constrained metadata still
  // arrives untrusted when the caller skips validate.ts.
  test('unvalidated ledger metadata cannot inject either', async () => {
    const out = withArtifacts(
      [
        "brief_version: '1.0'",
        'subject: { name: acme }',
        'evidence:',
        '  ledger: ledger.yaml',
        '  acquisition:',
        '    - tool: t',
        '      target: g',
        `      retrieved_at: ${JSON.stringify(payload('retrievedat'))}`,
      ].join('\n'),
      [
        "ledger_version: '1.0'",
        'generated_by: t',
        "generated_at: '2026-07-28'",
        'claims:',
        `  - id: ${JSON.stringify(payload('claimid'))}`,
        '    statement: s',
        `    class: ${JSON.stringify(payload('claimclass'))}`,
        `    confidence: ${JSON.stringify(payload('confidence'))}`,
        '    sources:',
        '      - locator: site:/a',
        '        quote: q',
        `        stance: ${JSON.stringify(payload('stance'))}`,
        `        as_of: ${JSON.stringify(payload('asof'))}`,
        '  - id: C-002',
        '    statement: sourceless',
        `    class: ${JSON.stringify(payload('nosrcclass'))}`,
        '    confidence: low',
      ].join('\n'),
    );
    await expectRendererMarkupOnly(out, 'ledger metadata');
    for (const m of ['retrievedat', 'claimid', 'claimclass', 'confidence', 'stance', 'asof', 'nosrcclass']) {
      expect(out, `${m} unescaped`).not.toContain(`<script>${m}`);
      expect(out, `${m} missing`).toContain(`&lt;script&gt;${m}`);
    }
  });

  test('single-slot positioning fallbacks escape their one field', async () => {
    for (const slot of ['need', 'target_customer', 'differentiation'] as const) {
      const out = withArtifacts(
        minimalBrief(`positioning: { ${slot}: ${JSON.stringify(payload(slot))} }`),
      );
      expect(out, slot).not.toContain('<script');
      expect(out, slot).toContain(`&lt;script&gt;${marker(slot)}`);
    }
  });

  // The suite asserted payloads stay inert but never that ordinary text
  // survives, so a double-encoding regression shipped green: an apostrophe
  // reached the reader as its own entity text.
  test('benign punctuation reaches the reader unchanged', async () => {
    const out = withArtifacts(
      [
        "brief_version: '1.0'",
        `subject: { name: acme, homepage: "https://team.example/it's-here" }`,
        'evidence: { ledger: ledger.yaml }',
        'value_map:',
        `  - attribute: "keeps your team's notes in git"`,
        `    value: "they're yours & they outlive it"`,
        `    proof: "read the team's notes | in any editor"`,
      ].join('\n'),
      ledgerWith(claim('C-001', "it's fine", 'observed', 'high')),
    );
    for (const shown of ['team&#39;s', 'they&#39;re', 'it&#39;s-here', 'yours &amp; they', 'notes | in any']) {
      expect(out, shown).toContain(shown);
    }
    // Each entity appears once — never wrapped in a second encoding.
    expect(out).not.toContain('&amp;#39;');
    expect(out).not.toContain('&amp;amp;');
  });

  test('a multi-line quote keeps its line structure', async () => {
    const out = withArtifacts(
      journalBrief(),
      ledgerWith(claim('C-001', 'tiers', 'observed', 'high', [
        src('site:/p', 'Tiers:\n- Free — up to 5 projects\n- Pro — $5/mo', 'supports'),
      ])),
    );
    expect(out).toContain('<p>Tiers:<br />- Free — up to 5 projects<br />- Pro — $5/mo</p>');
  });

  // marked's GFM autolink surface used to force a backslash into every field.
  // In HTML a bare URL is text, so the assertion is the stronger one: no field
  // can put a link on the page at all.
  test.each([
    'https://evil.example/x',
    'HTTP://evil.example/x',
    'FtP://evil.example/x',
    'www.evil.example',
    'foo.@evil.example',
  ])('no field turns %s into a link', async (url) => {
    const out = withArtifacts(
      minimalBrief(`positioning: { category: ${JSON.stringify(`a ${url} b`)} }`),
      ledgerWith(claim('C-001', `s ${url}`, `observed ${url}`, `high ${url}`, [
        src('site:/a', `q ${url}`, 'supports'),
      ])),
    );
    await expectRendererMarkupOnly(out, url);
    // And it reaches the reader as typed, with no escape wedged into it.
    expect(out).toContain(`a ${url} b`);
  });

  test('a quoted URL does not become a live link or grow a backslash', async () => {
    const out = withArtifacts(
      journalBrief(),
      ledgerWith(claim('C-001', 'linky', 'observed', 'high', [
        src('site:/p', 'See [docs](https://evil.example) and www.evil.example', 'supports'),
      ])),
    );
    expect(out).toContain('See [docs](https://evil.example) and www.evil.example');
    await expectRendererMarkupOnly(out, 'quoted url');
  });

  // Every shape below defeated a hand-written fence scanner at some point.
  // Nothing scans for a fence now: the findings renderer IS the parser, so an
  // unbalanced marker can only mis-shape the block it opens.
  test.each([
    ['unclosed, even count', ['```js', 'a', '```python', 'b']],
    ['balanced, odd count', ['```yaml', 'a', '```bash', 'b', '```']],
    ['tilde cannot close a backtick fence', ['```text', 'a', '~~~']],
    ['plain unclosed', ['```bash', 'echo oops']],
    ['balanced', ['```bash', 'echo ok', '```']],
    ['unclosed inside a list item', ['- step one', '', '  ```bash', '  run it']],
    ['unclosed inside a blockquote', ['> note', '> ```sh', '> run']],
    ['non-homogeneous run', ['~~~`js`', 'a', '~~~']],
    ['crlf line endings', ['```bash\r', 'echo ok\r', '```\r']],
  ])('the evidence survives findings.md: %s', async (_name, lines) => {
    const out = withFindings('# Findings', '', ...lines);
    expect(out).toContain('<h2>The evidence, claim by claim</h2>');
    expect(out.indexOf('<h2>The evidence, claim by claim</h2>'))
      .toBeLessThan(out.indexOf('<h2>What the analyze pass flagged</h2>'));
    expect(out).toContain('<span id="c-001"></span>');
    await expectRendererMarkupOnly(out, _name);
  });

  test('a CRLF findings file does not render a duplicate heading', async () => {
    writeFileSync(join(scratch, 'findings.md'), '# Findings\r\n\r\n## Gaps\r\n\r\nnone\r\n');
    const section = findingsSection(withArtifacts(journalBrief()));
    expect(section).not.toContain('<h1>Findings</h1>');
    expect(section).toContain('<h3>Gaps</h3>');
  });

  test('a statement ending in a period does not double it', async () => {
    const out = withArtifacts(
      journalBrief(),
      ledgerWith(
        [...claim('C-001', 'The README states five projects.', 'observed', 'high'), '    contradicts: [C-002]'],
        claim('C-002', 'The site states three projects.', 'observed', 'high'),
      ),
    );
    expect(out).not.toContain('..');
    expect(out).toContain('projects.</strong> Both sources are recorded');
  });

  test('a backtick in a locator cannot break its code element', async () => {
    const out = withArtifacts(
      journalBrief(),
      ledgerWith(claim('C-001', 'hostile locator', 'observed', 'high', [
        src('repo:READ`ME.md', 'quote', 'supports'),
      ])),
    );
    expect(out).toContain('<code>repo:READ`ME.md</code>');
  });

  test('a dangling or self-referential contradiction is dropped, not rendered broken', async () => {
    const out = withArtifacts(
      journalBrief(),
      ledgerWith(
        [...claim('C-001', 'real', 'observed', 'high'), '    contradicts: [C-999, C-001]'],
        claim('C-002', 'other', 'observed', 'high'),
      ),
    );
    expect(out).not.toContain('<h2>Unresolved contradictions</h2>');
    expect(out).not.toContain('<strong></strong>');
    expect(out).not.toContain('href="#c-999"');
  });

  // The pair used to round-trip through a '|'-joined dedupe key, so an id
  // carrying one recovered no claim and the row rendered from undefined.
  test('a claim id containing the old dedupe delimiter still renders its row', async () => {
    const out = withArtifacts(
      journalBrief(),
      ledgerWith(
        [...claim('A|B', 'first side', 'observed', 'high'), '    contradicts: ["C|D"]'],
        claim('C|D', 'second side', 'observed', 'high'),
      ),
    );
    expect(out).toContain('<h2>Unresolved contradictions</h2>');
    expect(out).toContain('says <strong>first side</strong>');
    expect(out).toContain('says <strong>second side</strong>');
    expect(out).not.toContain('<strong></strong>');
  });

  // A pipe used to have to be entity-encoded or it would split a GFM cell.
  // The cell is a <td> now, so the character reaches the reader as itself.
  test('a pipe in free text stays inside its table cell', async () => {
    const out = withArtifacts(
      minimalBrief([
        'workflows:',
        '  - name: flow',
        '    steps:',
        '      - step: run',
        '        description: "a | b"',
      ].join('\n')),
    );
    expect(out).toContain('<td>a | b</td>');
  });

  test('a newline in a table cell cannot start a new block', async () => {
    const out = withArtifacts(
      minimalBrief([
        'site_inventory:',
        '  - locator: site:/a',
        '    page_type: docs',
        '    rationale: "keep\\n\\nsecond block"',
      ].join('\n')),
    );
    expect(out).toContain('<td>keep\n\nsecond block</td>');
    await expectRendererMarkupOnly(out, 'table cell');
  });

  test('an inherited key is not mistaken for a stance label', async () => {
    const out = withArtifacts(
      journalBrief(),
      ledgerWith(claim('C-001', 'inherited', 'observed', 'high', [
        src('site:/a', 'q', 'constructor'),
      ])),
    );
    expect(out).not.toContain('native code');
    expect(out).toContain('constructor');
  });

  test('raw HTML in findings.md cannot form a tag, fenced or not', async () => {
    const section = findingsSection(withFindings(
      '# Findings',
      '',
      '## Contradictions',
      '',
      '<script>alert(1)</script>',
      '',
      '```html',
      '<img src=x onerror=alert(1)>',
      '```',
    ));
    await expectRendererMarkupOnly(section, 'raw html');
    expect(section).toContain('<h3>Contradictions</h3>');
    expect(section).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  test('no link syntax in findings.md can form an anchor', async () => {
    const section = findingsSection(withFindings(
      '# Findings',
      '',
      'Plain [click](javascript:alert(1)).',
      'Entity [c1](&#106;avascript:alert(1)).',
      'Tab [c2](java&Tab;script:alert(1)).',
      'Split ref [c3]:',
      'javascript:alert(1)',
      'Split paren [c4](',
      'javascript:alert(1))',
      'Pre-escaped \\[c5\\](javascript:alert(1)).',
      'Bare https://evil.example and www.evil.example and a@evil.example.',
      'Raw <img src=x onerror=alert(1)> and <javascript:alert(1)>.',
    ));
    expect(section).not.toContain('<a ');
    await expectRendererMarkupOnly(section, 'link syntax');
    // Each form reaches the reader as the analyze pass typed it.
    expect(section).toContain('Plain [click](javascript:alert(1)).');
    expect(section).toContain('Pre-escaped \\[c5\\](javascript:alert(1)).');
    expect(section).toContain('Bare https://evil.example and www.evil.example and a@evil.example.');
  });

  // The defect the HTML lane exists to close: escaping into markdown could not
  // express "literal" inside a fence, so a diagram was destroyed on the way to
  // the page while the runtime that would have drawn it was still inlined.
  test('a mermaid fence reaches the browser with its syntax intact', async () => {
    const section = findingsSection(withFindings(
      '# Findings',
      '',
      '## Flow',
      '',
      '```mermaid',
      'flowchart LR',
      '  A[intake] --> B(normalise)',
      '  C -->|yes| D[record both]',
      '```',
    ));
    expect(section).toContain('<pre class="mermaid">');
    // textContent decodes the entities, so mermaid parses what was typed.
    expect(section).toContain('A[intake] --&gt; B(normalise)');
    expect(section).not.toContain('\\[');
  });

  test('a code fence reaches the reader byte for byte', async () => {
    const section = findingsSection(withFindings(
      '# Findings',
      '',
      '## Repro',
      '',
      '```sh',
      String.raw`cp "C:\Users\a\notes" ops@host:/tmp  # see [C-001] & https://host/x`,
      '```',
    ));
    expect(section).toContain('<pre><code class="language-sh">');
    expect(section).toContain(
      String.raw`cp &quot;C:\Users\a\notes&quot; ops@host:/tmp  # see [C-001] &amp; https://host/x`,
    );
    expect(section).not.toContain('\\\\');
    expect(section).not.toContain('\\@');
  });

  // The fence's info string reaches a class attribute, the one place in the
  // findings render where author text lands inside a tag rather than between
  // two.
  test('a fence info string cannot break out of its class attribute', async () => {
    const section = findingsSection(withFindings(
      '# Findings',
      '',
      '```sh" onload="alert(1)',
      'echo hi',
      '```',
    ));
    await expectRendererMarkupOnly(section, 'fence info');
    expect(section).toContain('class="language-sh&quot;"');
  });

  test('findings prose keeps its inline formatting', async () => {
    const section = findingsSection(withFindings(
      '# Findings',
      '',
      '## Gaps',
      '',
      '- **bold** and *italic* and `code` in a list',
      '',
      '| field | value |',
      '| --- | --- |',
      '| path | `C:\\x` |',
    ));
    expect(section).toContain('<li><strong>bold</strong> and <em>italic</em> and <code>code</code> in a list</li>');
    expect(section).toContain('<th>field</th>');
    expect(section).toContain('<td><code>C:\\x</code></td>');
  });

  // A star inside a code span is a star, not the start of emphasis.
  test('a code span in findings.md swallows its own metacharacters', async () => {
    const section = findingsSection(withFindings('# Findings', '', 'run `a * b` and *then* stop'));
    expect(section).toContain('<code>a * b</code> and <em>then</em> stop');
  });

  test('contradictions get their own section and per-claim markers', async () => {
    const out = page();
    expect(out).toContain('<h2>Unresolved contradictions</h2>');
    expect(out).toContain('Recorded, not reconciled');
    expect(out).toContain('contradicts <a href="#c-002">C-002</a>');
    // One row per pair, not one per direction.
    expect(out.match(/Both sources are recorded/g)).toHaveLength(1);
  });

  test('source stance is never flattened — a refuting source says so', async () => {
    const out = withArtifacts(
      journalBrief(),
      ledgerWith(claim('C-001', 'contested', 'observed', 'low', [
        src('site:/a', 'yes', 'refutes'),
        src('site:/b', 'maybe', 'context'),
      ])),
    );
    expect(out).toContain('<strong>refutes</strong>');
    expect(out).toContain('context only');
    expect(out).toContain('<p>yes</p>');
    expect(out).toContain('<p>maybe</p>');
  });

  test('workflows render instead of vanishing', async () => {
    const out = page();
    expect(out).toContain('<h2>Where it sits in the work</h2>');
    expect(out).toContain('capture a finding');
    expect(out).toContain('<code>execute</code>');
  });

  test('class, confidence and derived_from all reach the evidence section', async () => {
    const out = page();
    expect(out).toContain('<strong>inferred</strong> moderate');
    expect(out).toContain('inferred from <a href="#c-001">C-001</a>');
  });

  test('a sourceless proposed claim says so instead of showing an empty quote', async () => {
    const out = page();
    expect(out).toContain('this claim is proposed');
    expect(out).not.toContain('<p></p>');
  });

  test('partial positioning never renders a dangling fragment', async () => {
    for (
      const [slots, expected] of [
        [
          'positioning: { target_customer: solo devs, need: notes near code }',
          '<strong>For</strong> solo devs <strong>who need</strong> notes near code, <strong>acme</strong>.',
        ],
        ['positioning: { key_benefit: versioned notes }', '<strong>acme</strong> that delivers versioned notes.'],
        ['positioning: { alternative: paper logs }', 'measured against: paper logs.'],
        ['positioning: { differentiation: git-native }', 'What sets it apart: git-native.'],
      ] as const
    ) {
      const out = withArtifacts(minimalBrief(slots));
      expect(out, slots).toContain(expected);
      expect(out, slots).not.toMatch(/,\n/);
    }
  });

  test('job stories do not double the template verbs', async () => {
    const out = page();
    expect(out).not.toContain('I want I want');
    expect(out).not.toContain('so I can I can');
    expect(out).toContain('<strong>so that</strong>');
  });

  test('the how-to-read promise matches what the claims actually carry', async () => {
    const sourceless = withArtifacts(
      journalBrief(),
      ledgerWith(claim('C-001', 'someday', 'proposed', 'low')),
    );
    expect(sourceless).not.toContain('carries a verbatim quote');
    expect(page()).toContain('carries a verbatim quote');
  });

  test('site inventory keeps the page title', async () => {
    expect(page()).toContain('Plans');
  });

  test('a missing ledger fails with a clear message, not a stack', async () => {
    writeFileSync(join(scratch, 'brief.yaml'), journalBrief());
    expect(() => renderBrief(scratch)).toThrow('render needs both');
  });

  test('verbatim ledger quotes appear in the evidence section', async () => {
    const out = page();
    expect(out).toContain('<p>Free — up to 3 projects</p>');
    expect(out).toContain('— supports, <code>site:/pricing#plans</code>, as of 2026-07-27');
  });

  test('findings are folded in with downgraded headings', async () => {
    const out = page();
    expect(out).toContain('<h2>What the analyze pass flagged</h2>');
    expect(out).toContain('<h3>Contradictions</h3>');
    expect(out).not.toContain('<h2>Contradictions</h2>');
  });

  // publish-page adopts the first h1 it finds when no title is given, so a
  // findings heading must never outrank the page's own.
  test('only the renderer writes an h1', async () => {
    const out = withFindings('# Findings', '', '# Hijacked Page Title', '', 'more');
    expect(out.match(/<h1>/g)).toHaveLength(1);
    expect(out).toContain('<h3>Hijacked Page Title</h3>');
  });

  test('a minimal brief renders without the optional sections', async () => {
    copyFileSync(join(skillRoot, 'schemas', 'fixtures', 'valid', 'brief.minimal.yaml'), join(scratch, 'brief.yaml'));
    copyFileSync(join(skillRoot, 'schemas', 'fixtures', 'valid', 'ledger.yaml'), join(scratch, 'ledger.yaml'));
    const out = renderBrief(scratch);
    expect(out).toContain('<h1>acme-notes: what the evidence says</h1>');
    expect(out).not.toContain('<h2>What it is</h2>');
    expect(out).not.toContain('<h2>What that gets you</h2>');
    expect(out).toContain('<h2>The evidence, claim by claim</h2>');
  });

  test('a lone CR in a quote cannot break out of its blockquote', async () => {
    const out = withArtifacts(
      journalBrief(),
      ledgerWith(claim('C-001', 'S.', 'observed', 'high', [
        src('site:/a', 'The vendor says X.\r\rNot the analyst speaking.', 'supports'),
      ])),
    );
    expect(out).toContain('<p>The vendor says X.<br /><br />Not the analyst speaking.</p>');
    await expectRendererMarkupOnly(out, 'lone cr');
  });

  test('a trailing backslash reaches the reader instead of eating a tag', async () => {
    const ledger = ledgerWith(claim('C-001', 'S.', 'observed', JSON.stringify('high\\')));
    const brief = minimalBrief('positioning: { category: journal, claims: ["C-001\\\\"] }');
    const out = withArtifacts(brief, ledger);
    expect(out).toContain('high\\</span>');
    expect(out).toContain('href="#c-001\\"');
    await expectRendererMarkupOnly(out, 'trailing backslash');
  });

  test('one claim reads "1 claim", an empty mix has no dangling dash', async () => {
    const one = withArtifacts(minimalBrief(''), ledgerWith(claim('C-001', 'S.', 'observed', 'high')));
    expect(one).toContain('1 claim — 1 observed');
    expect(one).not.toContain('1 claims');
    const empty = withArtifacts(minimalBrief(''), ledgerWith());
    expect(empty).toContain('0 claims</span>');
    expect(empty).not.toContain('0 claims —');
  });

  test('ledger provenance and origin detail reach the page', async () => {
    const brief = [
      "brief_version: '1.0'",
      'subject:',
      '  name: acme',
      '  origins:',
      '    - { id: kit, kind: repo, target: repo:../kit }',
      '    - { id: docs, kind: site, target: gh:acme/docs }',
      'evidence: { ledger: ledger.yaml }',
    ].join('\n');
    const out = withArtifacts(brief, ledgerWith(claim('C-001', 'S.', 'observed', 'high')));
    expect(out).toContain('Generated</strong> 2026-07-28');
    expect(out).toContain('Ledger generated by <code>t</code> at 2026-07-28.');
    expect(out).toContain(
      'Origins: <strong>kit</strong> (repo) <code>repo:../kit</code> · <strong>docs</strong> (site) <code>gh:acme/docs</code>.',
    );
  });

  test('category article adapts: an evidence ledger, a journal', async () => {
    copyFileSync(join(skillRoot, 'schemas', 'fixtures', 'valid', 'ledger.yaml'), join(scratch, 'ledger.yaml'));
    writeFileSync(
      join(scratch, 'brief.yaml'),
      [
        "brief_version: '1.0'",
        'subject: { name: x }',
        'evidence: { ledger: ledger.yaml }',
        'positioning: { category: evidence toolkit }',
      ].join('\n'),
    );
    expect(renderBrief(scratch)).toContain('is an evidence toolkit');
  });
});

describe('render.ts CLI', () => {
  const script = join(skillRoot, 'scripts', 'render.ts');

  test('writes brief-page.html into the intelligence dir by default', async () => {
    for (const f of ['brief.yaml', 'ledger.yaml', 'brief.md', 'findings.md']) {
      copyFileSync(join(mixed, f), join(scratch, f));
    }
    const result = spawnSync('bun', [script, scratch], { encoding: 'utf-8' });
    expect(result.status, result.stderr).toBe(0);
    // The page is HTML, so publish-page cannot lift a title from a heading.
    expect(result.stderr).toContain('--title "acme-notes: what the evidence says"');
    expect(readFileSync(join(scratch, 'brief-page.html'), 'utf-8'))
      .toContain('<h1>acme-notes: what the evidence says</h1>');
  });

  test('--out with no path is an error; with a path it writes there', async () => {
    for (const f of ['brief.yaml', 'ledger.yaml']) {
      copyFileSync(join(mixed, f), join(scratch, f));
    }
    const bad = spawnSync('bun', [script, scratch, '--out'], { encoding: 'utf-8' });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('usage:');
    const target = join(scratch, 'custom.html');
    const good = spawnSync('bun', [script, scratch, '--out', target], { encoding: 'utf-8' });
    expect(good.status, good.stderr).toBe(0);
    expect(readFileSync(target, 'utf-8')).toContain('what the evidence says');
  });
});

#!/usr/bin/env bun
// The deck rendering, and the CLI both lanes ship behind. A deck lands in
// publish-page's slide grammar — markdown the publisher reparses — so every
// untrusted value here is escaped into markdown as well as into HTML. The doc
// page carries no such second parse and lives in doc.ts.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  artifacts,
  chunk,
  collapse,
  contradictionPairs,
  type Dict,
  missingTerminalPeriod,
  positioningSentences,
} from './brief.ts';
import { briefTitle, renderBrief } from './doc.ts';
// The deck lands in publish-page's slide grammar, so the rule for what cuts a
// slide is read from the publisher rather than restated here.
import { outsideFences, slideBreaks } from '../../publish-page/slides.ts';

// GFM autolinks a bare URL, www host or email with no link syntax at all, which
// would let a crawled source place a live outbound link on a slide and swallow
// a following escape into the link text. These zero-width positions take a
// backslash, which the renderer resolves away, so the reader sees the original.
const AUTOLINK = /(?<=https?|ftp|mailto)(?=:)|(?<=www)(?=\.)|(?=@)/gi;

// Same triggers, consumed rather than straddled, for contexts that cannot use a
// backslash: entity-encoding the character stops the match in a markdown
// context and still displays as itself inside a raw-HTML island.
const AUTOLINK_CHAR = /(?<=https?|ftp|mailto):|(?<=www)\.|@/gi;

const ENTITY: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '|': '&#124;',
};

// The pipe is entity-encoded so escaped text cannot split a GFM table cell.
function esc(value: unknown): string {
  return collapse(value).replace(/[&<>"'|]/g, (c) => ENTITY[c] as string);
}

// Text inside a raw-HTML island. Entity-encoding the metacharacters keeps the
// island inert under any renderer; the backslash is in the set because left
// literal, a trailing one pairs with the `<` of the island's closing tag and
// marked's escape tokenizer eats the tag. ONE pass over the source: encoding
// after esc() would re-encode the hashes in entities esc() just produced, and
// an apostrophe would reach the reader as entity text.
function escText(value: unknown): string {
  return collapse(value)
    .replace(/[\\&<>"'|[\]()*_`~#!]/g, (c) => ENTITY[c] ?? `&#${c.charCodeAt(0)};`)
    // After the pass above, so its own entity output is not re-encoded.
    .replace(AUTOLINK_CHAR, (c) => `&#${c.charCodeAt(0)};`);
}

// Free text landing in a markdown context (headings, bold, blockquotes,
// table cells). Markdown-escape BEFORE esc(): esc() emits numeric entities
// whose '#' must not be re-escaped. Backslash escapes resolve back to the
// literal character when marked renders, so the reader sees the text
// verbatim. Line-start list/rule markers only act at the start of a line.
function mdEsc(value: unknown): string {
  const neutral = String(value ?? '')
    .replace(/[\\`*_[\]()!~#]/g, '\\$&')
    .replace(/^([-+=])/gm, '\\$1')
    .replace(/^(\d+)([.)])/gm, '$1\\$2')
    .replace(AUTOLINK, '\\');
  return esc(neutral);
}

// Inline <code> instead of a backtick span: a backtick inside a locator would
// terminate a span early. marked still runs inline markdown BETWEEN inline
// HTML tags, so the content needs mdEsc, not just esc.
function code(value: unknown): string {
  return `<code>${mdEsc(value)}</code>`;
}

// Inside a raw-HTML island marked runs no inline pass, so code()'s backslash
// escapes would reach the reader literally. Entities decode to themselves there.
function codeText(value: unknown): string {
  return `<code>${escText(value)}</code>`;
}

function chip(label: string, value: string): string {
  return `<span class="chip"><strong>${escText(label)}</strong> ${escText(value)}</span>`;
}

const STANCE_LABEL: Record<string, string> = {
  supports: 'supports',
  refutes: '**refutes**',
  context: 'context only',
};

function source(s: Dict): string {
  // Marker on every line: an unmarked second line continues as page prose,
  // letting a crawled source dictate the document. The trailing break keeps
  // the source's own line structure, which consecutive blockquote lines would
  // otherwise reflow into one run-on paragraph.
  const lines = String(s.quote ?? '').split(/\r\n?|\n/);
  const quoted = lines
    .map((l, i) => `> ${mdEsc(l)}${i < lines.length - 1 ? '<br />' : ''}`)
    .join('\n');
  // Own-property lookup: an inherited key such as `constructor` would return a
  // native function and reach the page without passing an escaper.
  const stance = Object.prototype.hasOwnProperty.call(STANCE_LABEL, String(s.stance ?? ''))
    ? STANCE_LABEL[s.stance]
    : mdEsc(s.stance);
  return `${quoted}\n>\n> — ${stance}, ${code(s.locator)}, as of ${mdEsc(s.as_of)}`;
}

// Outside code fences, HTML and link syntax are both neutralised: no anchor can
// form, so no destination needs judging. Filtering destinations instead
// re-decides per line, before entity decoding, what the parser decides later and
// across lines — a scheme survives as an entity or a split reference. A fence
// interior is escaped too, which the reader sees, because a code block resolves
// no escape: the doc lane emits HTML for exactly this reason.
function sanitizeFindings(body: string): string {
  return body
    // Backslash FIRST: an input `\[` would otherwise pair with the backslash
    // added below, and the brackets would go back to being live link syntax.
    .replace(/\\/g, '\\\\')
    .replace(/[[\]()<]/g, '\\$&')
    .replace(AUTOLINK, '\\');
}

// The deck theme owns the URL hash — it numbers slides there and rewrites it on
// every navigation — so a citation anchor would be clobbered instead of
// followed. Claim ids travel as mono text markers, never as links.
function citeIds(claims?: unknown): string {
  return ((claims ?? []) as string[]).join(' · ');
}

// One idea per slide: a mono kicker, one h2, then the shape. Both labels are
// escaped whatever their provenance — a bypass for "our own" strings is the
// gap a later edit walks through.
function slide(kicker: string, heading: string, ...body: string[]): string {
  return [
    `<div class="kicker">${escText(kicker)}</div>`,
    '',
    `## ${mdEsc(heading)}`,
    '',
    body.filter(Boolean).join('\n\n'),
  ].join('\n');
}

// Only counts the ledger actually yields, capped at the row's four columns.
// Contradictions outrank the class breakdown: a deck that pushes its conflict
// count off the row behind a fourth class label defeats the whole ledger.
function stats(ledger: Dict): string {
  const claims = (ledger.claims ?? []) as Dict[];
  const byClass = new Map<string, number>();
  for (const c of claims) {
    const label = collapse(c.class).trim();
    // An unclassed claim still counts toward the total; a numeral under a
    // blank label is a hole in the row.
    if (label) byClass.set(label, (byClass.get(label) ?? 0) + 1);
  }
  const conflicts = contradictionPairs(ledger).length;
  const cells: Array<[number, string]> = [[claims.length, claims.length === 1 ? 'claim' : 'claims']];
  if (conflicts > 0) cells.push([conflicts, conflicts === 1 ? 'contradiction' : 'contradictions']);
  for (const [label, n] of byClass) cells.push([n, label]);
  const row = cells.slice(0, 4).map(([n, label], i) =>
    `<div class="stat${i === 0 ? ' hot' : ''}"><div class="num">${n}</div>`
    + `<div class="lbl">${escText(label)}</div></div>`
  ).join('');
  return `<div class="stats">${row}</div>`;
}

// Two-tone at a fixed point: the subject's own name in ink, the deck's fixed
// clause in accent. Splitting the name itself would need a heuristic, and a
// crawled name is exactly where a heuristic produces nonsense.
function cover(brief: Dict, ledger: Dict): string {
  const subject = brief.subject ?? {};
  const name = subject.name ?? 'Untitled product';
  const stamp = brief.evidence?.acquired_at ?? ledger.generated_at;
  const thesis = subject.one_liner
    ? `<p class="thesis">${escText(subject.one_liner)}</p>`
    : '';
  return [
    '<div class="cover">',
    `<div class="kicker">${escText(stamp ? `evidence brief — ${stamp}` : 'evidence brief')}</div>`,
    `<h1>${escText(name)}${missingTerminalPeriod(name)} <span class="hi">What the evidence says.</span></h1>`,
    thesis,
    stats(ledger),
    '</div>',
  ].filter(Boolean).join('\n');
}

const DECK_VOICE = { esc: mdEsc, strong: (md: string) => `**${md}**` };

function positioningSlide(brief: Dict): string {
  const sentences = positioningSentences(brief, DECK_VOICE);
  if (sentences.length === 0) return '';
  const ids = citeIds(brief.positioning?.claims);
  const cited = ids ? `<div class="chips">${chip('claims', ids)}</div>` : '';
  return slide('positioning', 'What it is', sentences.join(' '), cited);
}

// Groups of three, widened to four when three would strand a single card. Four
// is the theme's column cap. When both sizes strand one (13, 25, …) a single
// four up front leaves a multiple of three behind it.
function cardGroups(rows: Dict[]): Dict[][] {
  if (rows.length === 0) return [];
  if (rows.length <= 4) return [rows];
  if (rows.length % 3 !== 1) return chunk(rows, 3);
  if (rows.length % 4 !== 1) return chunk(rows, 4);
  return [rows.slice(0, 4), ...chunk(rows.slice(4), 3)];
}

// An uncited card says so: a blank eyebrow reads as a styling slip rather than
// as the absence of a claim behind the card.
function card(claims: unknown, title: unknown, body: string): string {
  return `<div class="card"><span class="eyebrow">${escText(citeIds(claims) || 'uncited')}</span>`
    + `<h3>${escText(title)}</h3>${body}</div>`;
}

function cardSlide(kicker: string, heading: string, cards: string[]): string {
  const cols = cards.length >= 3 ? ` cols-${cards.length}` : '';
  return slide(kicker, heading, `<div class="cards${cols}">\n${cards.join('\n')}\n</div>`);
}

function valueSlides(brief: Dict): string[] {
  return cardGroups((brief.value_map ?? []) as Dict[]).map((group) =>
    cardSlide(
      'value',
      'What that gets you',
      group.map((r) =>
        card(
          r.claims,
          r.attribute,
          `<p>${escText(r.value)}${missingTerminalPeriod(r.value)}</p>`
            + (r.proof ? `<p><em>Check it: ${escText(r.proof)}.</em></p>` : ''),
        )
      ),
    )
  );
}

// The schema's job-story template already supplies "I want"/"so I can", so the
// values are bare clauses — the card states the frame once around them.
function jobStorySlides(brief: Dict): string[] {
  return cardGroups((brief.job_stories ?? []) as Dict[]).map((group) =>
    cardSlide(
      'jobs',
      "In a user's words",
      group.map((r) =>
        card(
          r.claims,
          `When ${collapse(r.situation)}`,
          `<p>${escText(r.motivation)}, so that ${escText(r.outcome)}.</p>`,
        )
      ),
    )
  );
}

// One flow per slide, its own name as the heading. The step marker is the scale
// the rows share, so it rides in .when instead of repeating inside the row.
function workflowSlides(brief: Dict): string[] {
  return ((brief.workflows ?? []) as Dict[]).flatMap((f) => {
    const steps = (f.steps ?? []) as Dict[];
    if (steps.length === 0) return [];
    return chunk(steps, 6).map((group) => {
      const rows = group.map((s) =>
        `<li class="rail dim">${escText(s.description)}`
        + `<span class="when">${escText(s.step)}</span></li>`
      ).join('\n');
      return slide(
        'workflow',
        collapse(f.name) || 'Where it sits in the work',
        `<ul class="rails">\n${rows}\n</ul>`,
      );
    });
  });
}

// Pages across four criteria: the columns are the point, and a card per page
// would run a small site to a dozen slides.
function siteInventorySlides(brief: Dict): string[] {
  return chunk((brief.site_inventory ?? []) as Dict[], 8).map((group) => {
    const body = group.map((r) => {
      const page = r.title ? `${code(r.locator)}<br/>${mdEsc(r.title)}` : code(r.locator);
      const ids = citeIds(r.claims);
      const why = `${mdEsc(r.rationale ?? '—')}${ids ? ` ${code(ids)}` : ''}`;
      return `| ${page} | ${mdEsc(r.page_type)} | ${mdEsc(r.disposition ?? '—')} | ${why} |`;
    }).join('\n');
    return slide(
      'surface',
      'Public surface, page by page',
      `| page | type | verdict | why |\n| --- | --- | --- | --- |\n${body}`,
    );
  });
}

function contradictionSlides(ledger: Dict): string[] {
  return chunk(contradictionPairs(ledger), 6).map((group) => {
    const rows = group.map(([one, two]) =>
      `<li class="rail red"><strong>${escText(one.statement)}</strong> — versus ${escText(two.statement)}`
      + `<span class="when">${escText(`${one.id} · ${two.id}`)}</span></li>`
    ).join('\n');
    return slide(
      'contradictions',
      'Unresolved contradictions',
      'Recorded, not reconciled — the sources disagree and the disagreement is the finding.',
      `<ul class="rails">\n${rows}\n</ul>`,
    );
  });
}

function cannotVerifySlides(brief: Dict): string[] {
  return chunk((brief.cannot_verify ?? []) as Dict[], 5).map((group) =>
    slide(
      'gaps',
      'What we could not verify',
      '<div class="callout"><strong>Said plainly.</strong> Absence of a slide means <em>unknown</em>, never <em>does not exist</em>.</div>',
      group.map((r) => `- **${mdEsc(r.what)}** — ${mdEsc(r.why)}.`).join('\n'),
    )
  );
}

function evidenceSlides(ledger: Dict): string[] {
  const claims = (ledger.claims ?? []) as Dict[];
  const known = new Set(claims.map((c) => c.id));
  const refs = (ids: unknown, self: string) =>
    ((ids ?? []) as string[]).filter((id) => id !== self && known.has(id));
  return claims.map((c) => {
    const from = refs(c.derived_from, c.id);
    const against = refs(c.contradicts, c.id);
    const chips = [
      chip(c.class, c.confidence),
      from.length ? chip('inferred from', from.join(' · ')) : '',
      against.length ? chip('contradicts', against.join(' · ')) : '',
    ].filter(Boolean).join('');
    const sources = (c.sources ?? []) as Dict[];
    const body = sources.length > 0
      ? sources.map(source).join('\n\n')
      : `> _No source — this claim is ${mdEsc(c.class)}, carried as such rather than dressed up._`;
    return slide(String(c.id ?? ''), String(c.statement ?? ''), `<div class="chips">${chips}</div>`, body);
  });
}

// A single-origin brief names its sources in subject.repo/homepage instead of
// an origins list. Both say where the evidence came from, and a deck that
// showed neither would send the reader back to the doc to find out.
function originRails(subject: Dict): Array<[unknown, string]> {
  const origins = (subject.origins ?? []) as Dict[];
  if (origins.length > 0) {
    return origins.map((o) => [o.id, `${escText(o.kind ?? 'origin')} ${codeText(o.target)}`]);
  }
  return ([['repo', subject.repo], ['site', subject.homepage]] as Array<[string, unknown]>)
    .filter(([, target]) => target)
    .map(([head, target]) => [head, codeText(target)]);
}

const RAIL_KEY: Record<string, string> = { hot: 'origin', gold: 'acquisition', dim: 'ledger' };

function provenanceSlides(brief: Dict, ledger: Dict): string[] {
  const acquired = (brief.evidence?.acquisition ?? []) as Dict[];
  const rail = (tone: string, head: unknown, bodyHtml: string, when?: unknown): [string, string] => [
    tone,
    `<li class="rail ${tone}"><strong>${escText(head)}</strong> — ${bodyHtml}`
    + (when ? `<span class="when">${escText(when)}</span>` : '') + '</li>',
  ];
  const rows: Array<[string, string]> = [
    ...originRails(brief.subject ?? {}).map(([head, body]) => rail('hot', head, body)),
    ...acquired.map((a) => rail('gold', a.tool, codeText(a.target), a.retrieved_at)),
    ...(ledger.generated_by || ledger.generated_at
      ? [rail('dim', 'ledger', `generated by ${codeText(ledger.generated_by ?? 'unrecorded')}`, ledger.generated_at)]
      : []),
  ];
  return chunk(rows, 6).map((group) => {
    // Per group, not per deck: a legend decoding one colour explains nothing,
    // and one decoding a colour absent from this slide explains a row that is
    // not on it.
    const tones = [...new Set(group.map(([tone]) => tone))];
    const legend = tones.length > 1
      ? `<div class="legend">${tones.map((t) => `<span class="key ${t}">${RAIL_KEY[t]}</span>`).join('')}</div>`
      : '';
    return slide(
      'provenance',
      'Where this came from',
      legend,
      `<ul class="rails">\n${group.map(([, html]) => html).join('\n')}\n</ul>`,
    );
  });
}

// Only the file's own first line is dropped as its title; a later `# ` would
// reach a slide as an h1 above the slide's own h2, and publish-page adopts the
// first h1 it finds as the page title whenever --title is omitted.
function demoteHeadings(body: string): string {
  const lines = body.split('\n');
  const open = outsideFences(lines);
  return lines.map((line, i) => (open[i] ? line.replace(/^# /, '### ') : line)).join('\n');
}

// Last, as in the doc: the analyze pass owns this file's block structure, so an
// unclosed fence of its own can only reach the slides after it. One slide per
// section it wrote. Every scan below runs over the WHOLE file, the scope the
// publisher scans the assembled deck over — restarting fence state per section
// puts the renderer half a fence out of step, reading a closing ``` as an
// opening one and leaving a rule unescaped exactly where the publisher cuts.
function findingsSlides(dir: string): string[] {
  const path = join(dir, 'findings.md');
  if (!existsSync(path)) return [];
  const body = demoteHeadings(
    readFileSync(path, 'utf-8')
      .replace(/\r\n?/g, '\n')
      .replace(/^# .*\n/, ''),
  ).trim();
  const lines = body.split('\n');
  const open = outsideFences(lines);
  // Safe before sanitising: it leaves fence markers and rules byte-identical.
  const breaks = slideBreaks(lines);
  const sections: Array<[string | null, string[]]> = [[null, []]];
  lines.forEach((line, i) => {
    // A heading inside a fence is content, not structure; splitting there would
    // strand the fence open across two slides and swallow their separator.
    if (open[i] && line.startsWith('## ')) sections.push([line.slice(3), []]);
    else sections[sections.length - 1][1].push(breaks[i] ? '\\---' : sanitizeFindings(line));
  });
  return sections.flatMap(([head, rows]) => {
    const content = rows.join('\n').trim();
    if (!content) return [];
    return [slide('analyze pass', head ?? 'What the analyze pass flagged', content)];
  });
}

export function renderDeck(dir: string): string {
  const { brief, ledger } = artifacts(dir);
  const slides = [
    cover(brief, ledger),
    positioningSlide(brief),
    ...valueSlides(brief),
    ...jobStorySlides(brief),
    ...workflowSlides(brief),
    ...siteInventorySlides(brief),
    ...contradictionSlides(ledger),
    ...cannotVerifySlides(brief),
    ...evidenceSlides(ledger),
    ...provenanceSlides(brief, ledger),
    ...findingsSlides(dir),
  ];
  return `${slides.filter(Boolean).join('\n\n---\n\n')}\n`;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const deck = argv.includes('--deck');
  const html = argv.includes('--html');
  const [dir, outFlag, outPath] = argv.filter((a) => a !== '--deck' && a !== '--html');
  if (!dir || (outFlag && (outFlag !== '--out' || !outPath))) {
    console.error('usage: render.ts <intelligence-dir> [--deck | --html] [--out <file>]');
    process.exit(2);
  }
  // The portable-HTML lane wraps the doc theme around the doc render; there is
  // no deck equivalent yet, and silently dropping one of the two flags would
  // hand back a page the caller did not ask for.
  if (deck && html) {
    console.error('error: --deck and --html cannot be combined — the portable page renders the doc lane only');
    process.exit(2);
  }
  try {
    const page = deck
      ? renderDeck(dir)
      : html
      ? await (await import('./html.ts')).renderBriefHtml(dir)
      : renderBrief(dir);
    const target = outPath ?? join(dir, deck ? 'brief-deck.md' : html ? 'index.html' : 'brief-page.html');
    writeFileSync(target, page);
    if (deck) {
      console.error('note: publish with --template deck --title "<subject>" — a deck has no document heading');
    } else if (!html) {
      console.error(`note: publish with --title ${JSON.stringify(briefTitle(dir))} — the page is HTML, not markdown`);
    }
    console.log(target);
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    process.exit(1);
  }
}

#!/usr/bin/env bun
// Renders a brief + ledger into the form a human reads, evidence woven in.
// Every interpolation is UNTRUSTED — quotes are verbatim crawled excerpts and
// the output publishes under a CSP that permits inline script. esc() stops
// HTML from forming; mdEsc() also stops markdown, since the page is markdown
// rendered later by marked — metacharacters would go live or eat characters.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Dict = Record<string, any>;

// GFM autolinks a bare URL, www host or email with no link syntax at all, which
// would let a crawled source place a live outbound link on the page and swallow
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

// Markdown containers — table rows, list items, HTML blocks — are
// line-structured: a newline ends the row or block and a blank line lets
// crawled text continue at document level, minting headings that read as the
// analyst's own. A lone CR counts: marked's lexer normalises it to LF, so CRCR
// is a blank line. source() splits a quote into lines first, so multi-line
// quotes keep their shape.
function collapse(value: unknown): string {
  return String(value ?? '').replace(/\s*[\r\n]\s*/g, ' ');
}

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

// Citation ids come from the brief, not only from the ledger, so a hostile
// one reaches the label. marked runs inline markdown between inline HTML
// tags, so the label needs the metacharacters encoded, not just esc().
function link(ref: string): string {
  return `<a href="#${escText(ref).toLowerCase()}">${escText(ref)}</a>`;
}

function cites(claims?: string[]): string {
  if (!claims || claims.length === 0) return '';
  return ` <sup>${claims.map(link).join(' ')}</sup>`;
}

function chip(label: string, value: string): string {
  return `<span class="chip"><strong>${escText(label)}</strong> ${escText(value)}</span>`;
}

function header(brief: Dict, ledger: Dict): string {
  const subject = brief.subject ?? {};
  const claims = (ledger.claims ?? []) as Dict[];
  const byClass = new Map<string, number>();
  for (const c of claims) byClass.set(c.class, (byClass.get(c.class) ?? 0) + 1);
  const mix = [...byClass.entries()].map(([k, n]) => `${n} ${k}`).join(' · ');
  const count = `${claims.length} claim${claims.length === 1 ? '' : 's'}${mix ? ` — ${mix}` : ''}`;
  const chips = [
    subject.repo ? chip('Repo', subject.repo) : '',
    subject.homepage ? chip('Site', subject.homepage) : '',
    chip('Evidence', count),
    brief.evidence?.acquired_at
      ? chip('Acquired', brief.evidence.acquired_at)
      : ledger.generated_at
      ? chip('Generated', ledger.generated_at)
      : '',
    (subject.origins?.length ?? 0) > 1
      ? chip('Origins', subject.origins.map((o: Dict) => o.id).join(' + '))
      : '',
  ].filter(Boolean).join('');
  const sourced = claims.some((c) => (c.sources ?? []).length > 0);
  const promise = sourced
    ? 'every observed and inferred claim carries a verbatim quote from an acquired source'
    : 'each claim states its kind and how solid its basis is';
  const lines = [`# ${mdEsc(subject.name ?? 'Untitled product')}: what the evidence says`, ''];
  lines.push(`<div class="chips">${chips}</div>`, '');
  if (subject.one_liner) lines.push(`**${mdEsc(subject.one_liner)}**`, '');
  lines.push(
    `<div class="callout"><strong>How to read this.</strong> Every material statement links to a numbered claim in the evidence section — ${promise}. Statements are labeled by kind (observed, inferred, proposed, unverified) and never stronger than their evidence. What could not be established is said plainly instead of papered over.</div>`,
    '',
  );
  return lines.join('\n');
}

function missingTerminalPeriod(value: unknown): string {
  return /[.!?]$/.test(String(value ?? '').trim()) ? '' : '.';
}

// Moore's six slots are all optional, so compose only complete thoughts: a
// half-filled slot set must read as a short sentence, never as a fragment
// ending in a comma — and no slot may be silently dropped.
function positioningSentences(brief: Dict): string[] {
  const p = brief.positioning;
  if (!p) return [];
  const name = mdEsc(brief.subject?.name ?? 'It');
  const sentences: string[] = [];
  const lead = p.target_customer && p.need
    ? `**For** ${mdEsc(p.target_customer)} **who need** ${mdEsc(p.need)}`
    : '';
  const subject = p.category ? `**${name}** is ${/^[aeiou]/i.test(p.category) ? 'an' : 'a'} ${mdEsc(p.category)}` : `**${name}**`;
  const benefit = p.key_benefit ? ` that delivers ${mdEsc(p.key_benefit)}` : '';
  if (lead || p.category || p.key_benefit) sentences.push(`${lead ? `${lead}, ` : ''}${subject}${benefit}.`);
  if (p.alternative && p.differentiation) {
    sentences.push(`**Unlike** ${mdEsc(p.alternative)}, ${mdEsc(p.differentiation)}.`);
  } else if (p.alternative) {
    sentences.push(`The alternative it is measured against: ${mdEsc(p.alternative)}.`);
  } else if (p.differentiation) {
    sentences.push(`What sets it apart: ${mdEsc(p.differentiation)}.`);
  }
  if (!lead && p.need) sentences.push(`The need it answers: ${mdEsc(p.need)}.`);
  if (!lead && p.target_customer) sentences.push(`Who it is for: ${mdEsc(p.target_customer)}.`);
  return sentences;
}

function positioning(brief: Dict): string {
  const sentences = positioningSentences(brief);
  if (sentences.length === 0) return '';
  return `## What it is\n\n${sentences.join(' ')}${cites(brief.positioning?.claims)}\n`;
}

function valueMap(brief: Dict): string {
  const rows = (brief.value_map ?? []) as Dict[];
  if (rows.length === 0) return '';
  const cards = rows.map((r) => {
    const proof = r.proof ? `<p><em>Check it: ${escText(r.proof)}.</em>${cites(r.claims)}</p>` : '';
    const tail = proof || (r.claims?.length ? `<p>${cites(r.claims)}</p>` : '');
    return `<div class="card"><h3>${escText(r.attribute)}</h3><p>${escText(r.value)}.</p>${tail}</div>`;
  }).join('\n');
  return `## What that gets you\n\n<div class="cards">\n${cards}\n</div>\n`;
}

// The schema's job-story template already supplies "I want"/"so I can", so the
// field values are the bare clauses — don't restate the verbs around them.
function jobStories(brief: Dict): string {
  const rows = (brief.job_stories ?? []) as Dict[];
  if (rows.length === 0) return '';
  const items = rows.map((r) =>
    `- **When** ${mdEsc(r.situation)} — ${mdEsc(r.motivation)}, **so that** ${mdEsc(r.outcome)}.${cites(r.claims)}`
  ).join('\n');
  return `## In a user's words\n\n${items}\n`;
}

function workflows(brief: Dict): string {
  const flows = (brief.workflows ?? []) as Dict[];
  if (flows.length === 0) return '';
  const blocks = flows.map((f) => {
    const steps = ((f.steps ?? []) as Dict[]).map((s) =>
      `| ${code(s.step)} | ${mdEsc(s.description)}${cites(s.claims)} |`
    ).join('\n');
    return `**${mdEsc(f.name)}**\n\n| step | what happens |\n| --- | --- |\n${steps}`;
  }).join('\n\n');
  return `## Where it sits in the work\n\n${blocks}\n`;
}

function siteInventory(brief: Dict): string {
  const rows = (brief.site_inventory ?? []) as Dict[];
  if (rows.length === 0) return '';
  const body = rows.map((r) => {
    const page = r.title ? `${code(r.locator)}<br/>${mdEsc(r.title)}` : code(r.locator);
    return `| ${page} | ${mdEsc(r.page_type)} | ${mdEsc(r.disposition ?? '—')} | ${mdEsc(r.rationale ?? '—')}${cites(r.claims)} |`;
  }).join('\n');
  return `## Public surface, page by page\n\n| page | type | verdict | why |\n| --- | --- | --- | --- |\n${body}\n`;
}

// A dangling or self-referential target would render an empty bold span and
// a dead anchor. renderBrief validates nothing, so unvalidated input reaches
// here; drop the pair rather than print a broken row.
function contradictionPairs(ledger: Dict): Array<[Dict, Dict]> {
  const claims = (ledger.claims ?? []) as Dict[];
  const byId = new Map(claims.map((c) => [c.id, c]));
  const pairs = new Set<string>();
  for (const c of claims) {
    for (const other of (c.contradicts ?? []) as string[]) {
      if (other === c.id || !byId.has(other)) continue;
      pairs.add([c.id, other].sort().join('|'));
    }
  }
  return [...pairs].map((pair) => {
    const [a, b] = pair.split('|');
    return [byId.get(a) as Dict, byId.get(b) as Dict];
  });
}

function contradictions(ledger: Dict): string {
  const pairs = contradictionPairs(ledger);
  if (pairs.length === 0) return '';
  const rows = pairs.map(([one, two]) => {
    return `- ${link(one.id)} says **${mdEsc(one.statement)}** — `
      + `while ${link(two.id)} says **${mdEsc(two.statement)}**${missingTerminalPeriod(two.statement)} `
      + 'Both sources are recorded; neither is silently preferred.';
  }).join('\n');
  return `## Unresolved contradictions\n\n<div class="callout"><strong>Recorded, not reconciled.</strong> The sources disagree and the disagreement is the finding.</div>\n\n${rows}\n`;
}

function cannotVerify(brief: Dict): string {
  const rows = (brief.cannot_verify ?? []) as Dict[];
  if (rows.length === 0) return '';
  const items = rows.map((r) => `- **${mdEsc(r.what)}** — ${mdEsc(r.why)}.`).join('\n');
  return `## What we could not verify\n\n<div class="callout"><strong>Said plainly.</strong> Absence of a section above means <em>unknown</em>, never <em>does not exist</em>.</div>\n\n${items}\n`;
}

// findings.md carries crawled quotes, so its structure is trusted but its
// inline content is not. Outside code fences, HTML and link syntax are both
// neutralised: no anchor can form, so no destination needs judging. Filtering
// destinations instead re-decides per line, before entity decoding, what the
// parser decides later and across lines — a scheme survives as an entity or a
// split reference. Fence interiors stay untouched: marked escapes them.
function sanitizeFindings(body: string): string {
  return body
    // Backslash FIRST: an input `\[` would otherwise pair with the backslash
    // added below, and the brackets would go back to being live link syntax.
    .replace(/\\/g, '\\\\')
    .replace(/[[\]()<]/g, '\\$&')
    .replace(AUTOLINK, '\\');
}

// An unclosed fence here renders the rest of THIS section as code and nothing
// else, because the section is last. Deciding whether to append a closer meant
// a second fence scanner shadowing the one that renders the page, and it
// disagreed on line endings, mixed runs and fences inside list items — each
// time appending a run that opened a fence over everything below.
function findings(dir: string): string {
  const path = join(dir, 'findings.md');
  if (!existsSync(path)) return '';
  const body = sanitizeFindings(
    readFileSync(path, 'utf-8')
      .replace(/\r\n?/g, '\n')
      .replace(/^# .*\n/, '')
      .replace(/^## /gm, '### ')
      .trim(),
  );
  return `## What the analyze pass flagged\n\n${body}\n`;
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

function evidence(brief: Dict, ledger: Dict): string {
  const claims = (ledger.claims ?? []) as Dict[];
  if (claims.length === 0) return '';
  const known = new Set(claims.map((c) => c.id));
  const refs = (ids: unknown, self: string) =>
    ((ids ?? []) as string[]).filter((id) => id !== self && known.has(id));
  const blocks = claims.map((c) => {
    const badge = `<span class="chip"><strong>${escText(c.class)}</strong> ${escText(c.confidence)}</span>`;
    const from = refs(c.derived_from, c.id);
    const against = refs(c.contradicts, c.id);
    const derived = from.length ? ` <em>inferred from ${from.map(link).join(', ')}</em>` : '';
    const conflict = against.length ? ` <em>contradicts ${against.map(link).join(', ')}</em>` : '';
    const sources = (c.sources ?? []) as Dict[];
    const body = sources.length > 0
      ? sources.map(source).join('\n>\n')
      : `> _No source — this claim is ${mdEsc(c.class)}, carried as such rather than dressed up._`;
    return `<span id="${escText(c.id).toLowerCase()}"></span>**${mdEsc(c.id)}** ${badge} — ${mdEsc(c.statement)}${derived}${conflict}\n\n${body}`;
  }).join('\n\n');
  const origins = ((brief.subject?.origins ?? []) as Dict[])
    .map((o) => `**${mdEsc(o.id)}** (${mdEsc(o.kind)}) ${code(o.target)}`).join(' · ');
  const acq = ((brief.evidence?.acquisition ?? []) as Dict[])
    .map((a) => `${code(a.tool)} → ${mdEsc(a.target)} (${mdEsc(a.retrieved_at)})`).join(' · ');
  const generated = [
    ledger.generated_by ? `by ${code(ledger.generated_by)}` : '',
    ledger.generated_at ? `at ${mdEsc(ledger.generated_at)}` : '',
  ].filter(Boolean).join(' ');
  const trail = [
    origins ? `Origins: ${origins}.` : '',
    acq ? `Acquired with: ${acq}.` : '',
    generated ? `Ledger generated ${generated}.` : '',
  ].filter(Boolean).join('\n\n');
  const provenance = trail ? `\n${trail}\n` : '';
  return `## The evidence, claim by claim\n\n${blocks}\n${provenance}`;
}

function artifacts(dir: string): { brief: Dict; ledger: Dict } {
  const briefPath = join(dir, 'brief.yaml');
  const ledgerPath = join(dir, 'ledger.yaml');
  for (const p of [briefPath, ledgerPath]) {
    if (!existsSync(p)) throw new Error(`missing ${p} — render needs both brief.yaml and ledger.yaml`);
  }
  return {
    brief: Bun.YAML.parse(readFileSync(briefPath, 'utf-8')) as Dict,
    ledger: Bun.YAML.parse(readFileSync(ledgerPath, 'utf-8')) as Dict,
  };
}

export function renderBrief(dir: string): string {
  const { brief, ledger } = artifacts(dir);
  const sections = [
    header(brief, ledger),
    positioning(brief),
    valueMap(brief),
    jobStories(brief),
    workflows(brief),
    siteInventory(brief),
    contradictions(ledger),
    cannotVerify(brief),
    evidence(brief, ledger),
    // Last: it is the one section whose block structure comes from a file we
    // did not generate, so nothing downstream can be damaged by it.
    findings(dir),
  ];
  return sections.filter(Boolean).join('\n');
}

// The deck theme owns the URL hash — it numbers slides there and rewrites it on
// every navigation — so a citation anchor would be clobbered instead of
// followed. Claim ids travel as mono text markers, never as links.
function citeIds(claims?: unknown): string {
  return ((claims ?? []) as string[]).join(' · ');
}

// Inside a raw-HTML island marked runs no inline pass, so code()'s backslash
// escapes would reach the reader literally. Entities decode to themselves there.
function codeText(value: unknown): string {
  return `<code>${escText(value)}</code>`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
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

function positioningSlide(brief: Dict): string {
  const sentences = positioningSentences(brief);
  if (sentences.length === 0) return '';
  const ids = citeIds(brief.positioning?.claims);
  const cited = ids ? `<div class="chips">${chip('claims', ids)}</div>` : '';
  return slide('positioning', 'What it is', sentences.join(' '), cited);
}

// Groups of three, widened to four when three would strand a single card. Four
// is the theme's column cap, so nothing here may widen past it.
function cardGroups(rows: Dict[]): Dict[][] {
  if (rows.length === 0) return [];
  return chunk(rows, rows.length <= 4 ? rows.length : rows.length % 3 === 1 ? 4 : 3);
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

// publish-page splits slides on a lone `---`, so an analyze-pass file could
// otherwise mint slides of its own. The backslash resolves away, leaving the
// hyphens the author typed. It lands inside fences too — the same trade the
// doc pipeline already takes rather than run a second fence scanner that
// disagrees with the one splitting the page.
function neutralizeSlideBreaks(body: string): string {
  return body.replace(/^[ \t]*---[ \t]*$/gm, '\\---');
}

// Last, as in the doc: the analyze pass owns this file's block structure, so an
// unclosed fence of its own can only reach the slides after it — and there are
// none. One slide per section it wrote.
function findingsSlides(dir: string): string[] {
  const path = join(dir, 'findings.md');
  if (!existsSync(path)) return [];
  const body = readFileSync(path, 'utf-8')
    .replace(/\r\n?/g, '\n')
    .replace(/^# .*\n/, '')
    .trim();
  return body.split(/^## /m).flatMap((section, i) => {
    const [head, ...rest] = section.split('\n');
    const heading = i === 0 ? 'What the analyze pass flagged' : head;
    const content = (i === 0 ? section : rest.join('\n')).trim();
    if (!content) return [];
    return [slide('analyze pass', heading, neutralizeSlideBreaks(sanitizeFindings(content)))];
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
  const [dir, outFlag, outPath] = argv.filter((a) => a !== '--deck');
  if (!dir || (outFlag && (outFlag !== '--out' || !outPath))) {
    console.error('usage: render.ts <intelligence-dir> [--deck] [--out <file>]');
    process.exit(2);
  }
  try {
    const page = deck ? renderDeck(dir) : renderBrief(dir);
    const target = outPath ?? join(dir, deck ? 'brief-deck.md' : 'brief-page.md');
    writeFileSync(target, page);
    if (deck) {
      console.error('note: publish with --template deck --title "<subject>" — a deck has no document heading');
    }
    console.log(target);
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    process.exit(1);
  }
}

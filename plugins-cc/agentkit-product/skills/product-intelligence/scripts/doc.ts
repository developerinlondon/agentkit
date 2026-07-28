// The page a human reads, emitted as HTML. Every interpolation is UNTRUSTED —
// quotes are verbatim crawled excerpts and the page publishes under a CSP that
// permits inline script — and esc() is the only thing standing between a
// crawled string and the document, in element content and attributes alike.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  artifacts,
  contradictionPairs,
  type Dict,
  missingTerminalPeriod,
  positioningSentences,
  subjectTitle,
} from './brief.ts';
import { findingsHtml } from './findings.ts';
import { esc } from './markup.ts';

const VOICE = { esc, strong: (html: string) => `<strong>${html}</strong>` };

const STANCE_LABEL: Record<string, string> = {
  supports: 'supports',
  refutes: '<strong>refutes</strong>',
  context: 'context only',
};

function code(value: unknown): string {
  return `<code>${esc(value)}</code>`;
}

// Lowercased before escaping, never after: the entities esc() emits carry
// characters of their own, and case-folding them would break the pairing
// between a citation's href and its claim's anchor.
function anchor(id: unknown): string {
  return esc(String(id ?? '').toLowerCase());
}

function link(ref: string): string {
  return `<a href="#${anchor(ref)}">${esc(ref)}</a>`;
}

function cites(claims?: string[]): string {
  if (!claims || claims.length === 0) return '';
  return ` <sup>${claims.map(link).join(' ')}</sup>`;
}

function chip(label: unknown, value: unknown): string {
  return `<span class="chip"><strong>${esc(label)}</strong> ${esc(value)}</span>`;
}

function heading(text: string, ...parts: string[]): string {
  return [`<h2>${text}</h2>`, ...parts.filter(Boolean)].join('\n');
}

function list(items: string[]): string {
  return `<ul>\n${items.map((i) => `<li>${i}</li>`).join('\n')}\n</ul>`;
}

function table(head: string[], rows: string[][]): string {
  const th = head.map((h) => `<th>${h}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('\n');
  return `<table>\n<thead>\n<tr>${th}</tr>\n</thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
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
  const promise = claims.some((c) => (c.sources ?? []).length > 0)
    ? 'every observed and inferred claim carries a verbatim quote from an acquired source'
    : 'each claim states its kind and how solid its basis is';
  return [
    `<h1>${esc(subjectTitle(brief))}</h1>`,
    `<div class="chips">${chips}</div>`,
    subject.one_liner ? `<p><strong>${esc(subject.one_liner)}</strong></p>` : '',
    `<div class="callout"><strong>How to read this.</strong> Every material statement links to a numbered claim in the evidence section — ${promise}. Statements are labeled by kind (observed, inferred, proposed, unverified) and never stronger than their evidence. What could not be established is said plainly instead of papered over.</div>`,
  ].filter(Boolean).join('\n');
}

function positioning(brief: Dict): string {
  const sentences = positioningSentences(brief, VOICE);
  if (sentences.length === 0) return '';
  return heading('What it is', `<p>${sentences.join(' ')}${cites(brief.positioning?.claims)}</p>`);
}

function valueMap(brief: Dict): string {
  const rows = (brief.value_map ?? []) as Dict[];
  if (rows.length === 0) return '';
  const cards = rows.map((r) => {
    const proof = r.proof ? `<p><em>Check it: ${esc(r.proof)}.</em>${cites(r.claims)}</p>` : '';
    const tail = proof || (r.claims?.length ? `<p>${cites(r.claims)}</p>` : '');
    return `<div class="card"><h3>${esc(r.attribute)}</h3><p>${esc(r.value)}.</p>${tail}</div>`;
  }).join('\n');
  return heading('What that gets you', `<div class="cards">\n${cards}\n</div>`);
}

// The schema's job-story template already supplies "I want"/"so I can", so the
// field values are the bare clauses — don't restate the verbs around them.
function jobStories(brief: Dict): string {
  const rows = (brief.job_stories ?? []) as Dict[];
  if (rows.length === 0) return '';
  return heading(
    "In a user's words",
    list(rows.map((r) =>
      `<strong>When</strong> ${esc(r.situation)} — ${esc(r.motivation)}, `
      + `<strong>so that</strong> ${esc(r.outcome)}.${cites(r.claims)}`
    )),
  );
}

function workflows(brief: Dict): string {
  const flows = (brief.workflows ?? []) as Dict[];
  if (flows.length === 0) return '';
  const blocks = flows.map((f) => {
    const rows = ((f.steps ?? []) as Dict[])
      .map((s) => [code(s.step), `${esc(s.description)}${cites(s.claims)}`]);
    return `<p><strong>${esc(f.name)}</strong></p>\n${table(['step', 'what happens'], rows)}`;
  });
  return heading('Where it sits in the work', blocks.join('\n'));
}

function siteInventory(brief: Dict): string {
  const rows = (brief.site_inventory ?? []) as Dict[];
  if (rows.length === 0) return '';
  const body = rows.map((r) => [
    r.title ? `${code(r.locator)}<br />${esc(r.title)}` : code(r.locator),
    esc(r.page_type),
    esc(r.disposition ?? '—'),
    `${esc(r.rationale ?? '—')}${cites(r.claims)}`,
  ]);
  return heading('Public surface, page by page', table(['page', 'type', 'verdict', 'why'], body));
}

function contradictions(ledger: Dict): string {
  const pairs = contradictionPairs(ledger);
  if (pairs.length === 0) return '';
  const rows = pairs.map(([one, two]) =>
    `${link(one.id)} says <strong>${esc(one.statement)}</strong> — `
    + `while ${link(two.id)} says <strong>${esc(two.statement)}</strong>`
    + `${missingTerminalPeriod(two.statement)} Both sources are recorded; neither is silently preferred.`
  );
  return heading(
    'Unresolved contradictions',
    '<div class="callout"><strong>Recorded, not reconciled.</strong> The sources disagree and the disagreement is the finding.</div>',
    list(rows),
  );
}

function cannotVerify(brief: Dict): string {
  const rows = (brief.cannot_verify ?? []) as Dict[];
  if (rows.length === 0) return '';
  return heading(
    'What we could not verify',
    '<div class="callout"><strong>Said plainly.</strong> Absence of a section above means <em>unknown</em>, never <em>does not exist</em>.</div>',
    list(rows.map((r) => `<strong>${esc(r.what)}</strong> — ${esc(r.why)}.`)),
  );
}

// The quote keeps its own line structure: consecutive lines of a blockquote
// would otherwise reflow into one run-on paragraph.
function source(s: Dict): string {
  const quote = String(s.quote ?? '').split(/\r\n?|\n/).map(esc).join('<br />');
  // Own-property lookup: an inherited key such as `constructor` would return a
  // native function and reach the page without passing an escaper.
  const stance = Object.prototype.hasOwnProperty.call(STANCE_LABEL, String(s.stance ?? ''))
    ? STANCE_LABEL[s.stance]
    : esc(s.stance);
  return `<p>${quote}</p>\n<p>— ${stance}, ${code(s.locator)}, as of ${esc(s.as_of)}</p>`;
}

function claimBlock(c: Dict, known: Set<string>): string {
  const refs = (ids: unknown) => ((ids ?? []) as string[]).filter((id) => id !== c.id && known.has(id));
  const from = refs(c.derived_from);
  const against = refs(c.contradicts);
  const derived = from.length ? ` <em>inferred from ${from.map(link).join(', ')}</em>` : '';
  const conflict = against.length ? ` <em>contradicts ${against.map(link).join(', ')}</em>` : '';
  const sources = (c.sources ?? []) as Dict[];
  const body = sources.length > 0
    ? sources.map(source).join('\n')
    : `<p><em>No source — this claim is ${esc(c.class)}, carried as such rather than dressed up.</em></p>`;
  return `<p><span id="${anchor(c.id)}"></span><strong>${esc(c.id)}</strong> `
    + `${chip(c.class, c.confidence)} — ${esc(c.statement)}${derived}${conflict}</p>\n`
    + `<blockquote>\n${body}\n</blockquote>`;
}

function provenance(brief: Dict, ledger: Dict): string {
  const origins = ((brief.subject?.origins ?? []) as Dict[])
    .map((o) => `<strong>${esc(o.id)}</strong> (${esc(o.kind)}) ${code(o.target)}`).join(' · ');
  const acq = ((brief.evidence?.acquisition ?? []) as Dict[])
    .map((a) => `${code(a.tool)} → ${esc(a.target)} (${esc(a.retrieved_at)})`).join(' · ');
  const generated = [
    ledger.generated_by ? `by ${code(ledger.generated_by)}` : '',
    ledger.generated_at ? `at ${esc(ledger.generated_at)}` : '',
  ].filter(Boolean).join(' ');
  return [
    origins ? `<p>Origins: ${origins}.</p>` : '',
    acq ? `<p>Acquired with: ${acq}.</p>` : '',
    generated ? `<p>Ledger generated ${generated}.</p>` : '',
  ].filter(Boolean).join('\n');
}

function evidence(brief: Dict, ledger: Dict): string {
  const claims = (ledger.claims ?? []) as Dict[];
  if (claims.length === 0) return '';
  const known = new Set(claims.map((c) => c.id));
  return heading(
    'The evidence, claim by claim',
    claims.map((c) => claimBlock(c, known)).join('\n'),
    provenance(brief, ledger),
  );
}

function findings(dir: string): string {
  const path = join(dir, 'findings.md');
  if (!existsSync(path)) return '';
  const body = readFileSync(path, 'utf-8')
    .replace(/\r\n?/g, '\n')
    .replace(/^# .*\n/, '')
    .trim();
  return heading('What the analyze pass flagged', findingsHtml(body));
}

export function briefTitle(dir: string): string {
  return subjectTitle(artifacts(dir).brief);
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
    // Last: the one section whose block structure comes from a file we did not
    // generate, so nothing downstream can be damaged by it.
    findings(dir),
  ];
  return `${sections.filter(Boolean).join('\n')}\n`;
}

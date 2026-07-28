#!/usr/bin/env bun
// Renders a brief + ledger into the form a human reads, evidence woven in.
// Every interpolation is UNTRUSTED — quotes are verbatim crawled excerpts and
// the output publishes under a CSP that permits inline script. esc() stops
// HTML from forming; mdEsc() also stops markdown, since the page is markdown
// rendered later by marked — metacharacters would go live or eat characters.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Dict = Record<string, any>;

// Newlines collapse and the pipe becomes an entity because markdown
// containers — table rows, list items, HTML blocks — are line-structured: a
// newline ends the row or block and a blank line lets crawled text continue
// at document level, minting headings that read as the analyst's own.
// source() splits a quote into lines before escaping, so multi-line quotes
// keep their shape.
function esc(value: unknown): string {
  return String(value ?? '').replace(/\s*\r?\n\s*/g, ' ').replace(
    /[&<>"'|]/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '|': '&#124;' })[
        c
      ] as string,
  );
}

// Text inside a raw-HTML island. marked does not run inline markdown inside a
// block-level HTML block, but that is a property of the consumer, not of this
// output — entity-encoding the metacharacters makes the island safe under any
// renderer while displaying the character unchanged. Backslash escaping cannot
// be used here: it would show as a literal backslash.
function escText(value: unknown): string {
  return esc(value).replace(/[[\]()*_`~#!]/g, (c) => `&#${c.charCodeAt(0)};`);
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
    .replace(/^(\d+)([.)])/gm, '$1\\$2');
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
    brief.evidence?.acquired_at ? chip('Acquired', brief.evidence.acquired_at) : '',
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

// Moore's six slots are all optional, so compose only complete thoughts: a
// half-filled slot set must read as a short sentence, never as a fragment
// ending in a comma — and no slot may be silently dropped.
function positioning(brief: Dict): string {
  const p = brief.positioning;
  if (!p) return '';
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
  if (sentences.length === 0) return '';
  return `## What it is\n\n${sentences.join(' ')}${cites(p.claims)}\n`;
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

function contradictions(ledger: Dict): string {
  const claims = (ledger.claims ?? []) as Dict[];
  const byId = new Map(claims.map((c) => [c.id, c]));
  // A dangling or self-referential target would render an empty bold span and
  // a dead anchor. renderBrief validates nothing, so unvalidated input reaches
  // here; drop the pair rather than print a broken row.
  const pairs = new Set<string>();
  for (const c of claims) {
    for (const other of (c.contradicts ?? []) as string[]) {
      if (other === c.id || !byId.has(other)) continue;
      pairs.add([c.id, other].sort().join('|'));
    }
  }
  if (pairs.size === 0) return '';
  const rows = [...pairs].map((pair) => {
    const [a, b] = pair.split('|');
    const one = byId.get(a);
    const two = byId.get(b);
    return `- ${link(a)} says **${mdEsc(one?.statement)}** — while ${link(b)} says **${mdEsc(two?.statement)}**. `
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

// findings.md is authored by the analyze pass but quotes crawled text, so
// its markdown structure is trusted while raw HTML is not: outside code
// fences HTML is entity-escaped and javascript:/data:/vbscript: link
// destinations are defused by escaping the link syntax. Fence interiors stay
// untouched — marked escapes them wholesale, and an unclosed fence swallows
// the rest of the file as code there too, so a skipped region is never live.
function sanitizeFindings(body: string): string {
  const out: string[] = [];
  let fence = '';
  for (const line of body.split('\n')) {
    const run = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      out.push(line);
      if (run && run[1][0] === fence[0] && run[1].length >= fence.length && run[2].trim() === '') {
        fence = '';
      }
      continue;
    }
    if (run && !(run[1][0] === '`' && run[2].includes('`'))) {
      fence = run[1];
      out.push(line);
      continue;
    }
    out.push(
      line
        .replace(/&(?![a-zA-Z][a-zA-Z0-9]{1,31};|#\d{1,7};|#[xX][0-9a-fA-F]{1,6};)/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/\]\((?=\s*(javascript|data|vbscript)\s*:)/gi, ']\\(')
        .replace(/^(\s{0,3})\[(?=[^\]]*\]:\s*(javascript|data|vbscript)\s*:)/gi, '$1\\['),
    );
  }
  return out.join('\n');
}

function findings(dir: string): string {
  const path = join(dir, 'findings.md');
  if (!existsSync(path)) return '';
  const body = sanitizeFindings(
    readFileSync(path, 'utf-8')
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
  // letting a crawled source dictate the document.
  const quoted = String(s.quote ?? '').split('\n').map((l) => `> ${mdEsc(l)}`).join('\n');
  const stance = STANCE_LABEL[s.stance] ?? mdEsc(s.stance);
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
  const acq = ((brief.evidence?.acquisition ?? []) as Dict[])
    .map((a) => `${code(a.tool)} → ${mdEsc(a.target)} (${mdEsc(a.retrieved_at)})`).join(' · ');
  const provenance = acq ? `\nAcquired with: ${acq}.\n` : '';
  return `## The evidence, claim by claim\n\n${blocks}\n${provenance}`;
}

export function renderBrief(dir: string): string {
  const briefPath = join(dir, 'brief.yaml');
  const ledgerPath = join(dir, 'ledger.yaml');
  for (const p of [briefPath, ledgerPath]) {
    if (!existsSync(p)) throw new Error(`missing ${p} — render needs both brief.yaml and ledger.yaml`);
  }
  const brief = Bun.YAML.parse(readFileSync(briefPath, 'utf-8')) as Dict;
  const ledger = Bun.YAML.parse(readFileSync(ledgerPath, 'utf-8')) as Dict;
  const sections = [
    header(brief, ledger),
    positioning(brief),
    valueMap(brief),
    jobStories(brief),
    workflows(brief),
    siteInventory(brief),
    contradictions(ledger),
    cannotVerify(brief),
    findings(dir),
    evidence(brief, ledger),
  ];
  return sections.filter(Boolean).join('\n');
}

if (import.meta.main) {
  const [dir, outFlag, outPath] = process.argv.slice(2);
  if (!dir || (outFlag && (outFlag !== '--out' || !outPath))) {
    console.error('usage: render.ts <intelligence-dir> [--out <file>]');
    process.exit(2);
  }
  try {
    const page = renderBrief(dir);
    const target = outPath ?? join(dir, 'brief-page.md');
    writeFileSync(target, page);
    console.log(target);
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    process.exit(1);
  }
}

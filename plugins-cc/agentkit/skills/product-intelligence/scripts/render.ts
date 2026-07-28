#!/usr/bin/env bun
// Renders a brief + ledger into the form a human reads, evidence woven in.
// Everything interpolated here is UNTRUSTED — quotes are verbatim excerpts
// from crawled sources and the output publishes to a URL whose CSP permits
// inline script.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Dict = Record<string, any>;

function esc(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function link(ref: string): string {
  return `<a href="#${esc(ref).toLowerCase()}">${esc(ref)}</a>`;
}

function cites(claims?: string[]): string {
  if (!claims || claims.length === 0) return '';
  return ` <sup>${claims.map(link).join(' ')}</sup>`;
}

function chip(label: string, value: string): string {
  return `<span class="chip"><strong>${esc(label)}</strong> ${esc(value)}</span>`;
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
  const lines = [`# ${esc(subject.name ?? 'Untitled product')}: what the evidence says`, ''];
  lines.push(`<div class="chips">${chips}</div>`, '');
  if (subject.one_liner) lines.push(`**${esc(subject.one_liner)}**`, '');
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
  const name = esc(brief.subject?.name ?? 'It');
  const sentences: string[] = [];
  const lead = p.target_customer && p.need
    ? `**For** ${esc(p.target_customer)} **who need** ${esc(p.need)}`
    : '';
  const subject = p.category ? `**${name}** is ${/^[aeiou]/i.test(p.category) ? 'an' : 'a'} ${esc(p.category)}` : `**${name}**`;
  const benefit = p.key_benefit ? ` that delivers ${esc(p.key_benefit)}` : '';
  if (lead || p.category || p.key_benefit) sentences.push(`${lead ? `${lead}, ` : ''}${subject}${benefit}.`);
  if (p.alternative && p.differentiation) {
    sentences.push(`**Unlike** ${esc(p.alternative)}, ${esc(p.differentiation)}.`);
  } else if (p.alternative) {
    sentences.push(`The alternative it is measured against: ${esc(p.alternative)}.`);
  } else if (p.differentiation) {
    sentences.push(`What sets it apart: ${esc(p.differentiation)}.`);
  }
  if (!lead && p.need) sentences.push(`The need it answers: ${esc(p.need)}.`);
  if (!lead && p.target_customer) sentences.push(`Who it is for: ${esc(p.target_customer)}.`);
  if (sentences.length === 0) return '';
  return `## What it is\n\n${sentences.join(' ')}${cites(p.claims)}\n`;
}

function valueMap(brief: Dict): string {
  const rows = (brief.value_map ?? []) as Dict[];
  if (rows.length === 0) return '';
  const cards = rows.map((r) => {
    const proof = r.proof ? `<p><em>Check it: ${esc(r.proof)}.</em>${cites(r.claims)}</p>` : '';
    const tail = proof || (r.claims?.length ? `<p>${cites(r.claims)}</p>` : '');
    return `<div class="card"><h3>${esc(r.attribute)}</h3><p>${esc(r.value)}.</p>${tail}</div>`;
  }).join('\n');
  return `## What that gets you\n\n<div class="cards">\n${cards}\n</div>\n`;
}

// The schema's job-story template already supplies "I want"/"so I can", so the
// field values are the bare clauses — don't restate the verbs around them.
function jobStories(brief: Dict): string {
  const rows = (brief.job_stories ?? []) as Dict[];
  if (rows.length === 0) return '';
  const items = rows.map((r) =>
    `- **When** ${esc(r.situation)} — ${esc(r.motivation)}, **so that** ${esc(r.outcome)}.${cites(r.claims)}`
  ).join('\n');
  return `## In a user's words\n\n${items}\n`;
}

function workflows(brief: Dict): string {
  const flows = (brief.workflows ?? []) as Dict[];
  if (flows.length === 0) return '';
  const blocks = flows.map((f) => {
    const steps = ((f.steps ?? []) as Dict[]).map((s) =>
      `| \`${esc(s.step)}\` | ${esc(s.description)}${cites(s.claims)} |`
    ).join('\n');
    return `**${esc(f.name)}**\n\n| step | what happens |\n| --- | --- |\n${steps}`;
  }).join('\n\n');
  return `## Where it sits in the work\n\n${blocks}\n`;
}

function siteInventory(brief: Dict): string {
  const rows = (brief.site_inventory ?? []) as Dict[];
  if (rows.length === 0) return '';
  const body = rows.map((r) => {
    const page = r.title ? `\`${esc(r.locator)}\`<br/>${esc(r.title)}` : `\`${esc(r.locator)}\``;
    return `| ${page} | ${esc(r.page_type)} | ${esc(r.disposition ?? '—')} | ${esc(r.rationale ?? '—')}${cites(r.claims)} |`;
  }).join('\n');
  return `## Public surface, page by page\n\n| page | type | verdict | why |\n| --- | --- | --- | --- |\n${body}\n`;
}

function contradictions(ledger: Dict): string {
  const claims = (ledger.claims ?? []) as Dict[];
  const pairs = new Set<string>();
  for (const c of claims) {
    for (const other of (c.contradicts ?? []) as string[]) {
      pairs.add([c.id, other].sort().join('|'));
    }
  }
  if (pairs.size === 0) return '';
  const byId = new Map(claims.map((c) => [c.id, c]));
  const rows = [...pairs].map((pair) => {
    const [a, b] = pair.split('|');
    const one = byId.get(a);
    const two = byId.get(b);
    return `- ${link(a)} says **${esc(one?.statement)}** — while ${link(b)} says **${esc(two?.statement)}**. `
      + 'Both sources are recorded; neither is silently preferred.';
  }).join('\n');
  return `## Unresolved contradictions\n\n<div class="callout"><strong>Recorded, not reconciled.</strong> The sources disagree and the disagreement is the finding.</div>\n\n${rows}\n`;
}

function cannotVerify(brief: Dict): string {
  const rows = (brief.cannot_verify ?? []) as Dict[];
  if (rows.length === 0) return '';
  const items = rows.map((r) => `- **${esc(r.what)}** — ${esc(r.why)}.`).join('\n');
  return `## What we could not verify\n\n<div class="callout"><strong>Said plainly.</strong> Absence of a section above means <em>unknown</em>, never <em>does not exist</em>.</div>\n\n${items}\n`;
}

function findings(dir: string): string {
  const path = join(dir, 'findings.md');
  if (!existsSync(path)) return '';
  const body = readFileSync(path, 'utf-8')
    .replace(/^# .*\n/, '')
    .replace(/^## /gm, '### ')
    .trim();
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
  const quoted = String(s.quote ?? '').split('\n').map((l) => `> ${esc(l)}`).join('\n');
  const stance = STANCE_LABEL[s.stance] ?? esc(s.stance);
  return `${quoted}\n>\n> — ${stance}, \`${esc(s.locator)}\`, as of ${esc(s.as_of)}`;
}

function evidence(brief: Dict, ledger: Dict): string {
  const claims = (ledger.claims ?? []) as Dict[];
  if (claims.length === 0) return '';
  const blocks = claims.map((c) => {
    const badge = `<span class="chip"><strong>${esc(c.class)}</strong> ${esc(c.confidence)}</span>`;
    const derived = (c.derived_from ?? []).length
      ? ` <em>inferred from ${(c.derived_from as string[]).map(link).join(', ')}</em>`
      : '';
    const conflict = (c.contradicts ?? []).length
      ? ` <em>contradicts ${(c.contradicts as string[]).map(link).join(', ')}</em>`
      : '';
    const sources = (c.sources ?? []) as Dict[];
    const body = sources.length > 0
      ? sources.map(source).join('\n>\n')
      : `> _No source — this claim is ${esc(c.class)}, carried as such rather than dressed up._`;
    return `<span id="${esc(c.id).toLowerCase()}"></span>**${esc(c.id)}** ${badge} — ${esc(c.statement)}${derived}${conflict}\n\n${body}`;
  }).join('\n\n');
  const acq = ((brief.evidence?.acquisition ?? []) as Dict[])
    .map((a) => `\`${esc(a.tool)}\` → ${esc(a.target)} (${esc(a.retrieved_at)})`).join(' · ');
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

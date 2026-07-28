#!/usr/bin/env bun
// Renders a brief + ledger into one readable page-ready document. The YAML
// artifacts are the auditable form; this is the form a human actually reads —
// evidence woven in, not referenced by opaque codes.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Dict = Record<string, any>;

function link(ref: string): string {
  return `<a href="#${ref.toLowerCase()}">${ref}</a>`;
}

function cites(claims?: string[]): string {
  if (!claims || claims.length === 0) return '';
  return ` <sup>${claims.map(link).join(' ')}</sup>`;
}

function chip(label: string, value: string): string {
  return `<span class="chip"><strong>${label}</strong> ${value}</span>`;
}

function header(brief: Dict, ledger: Dict): string {
  const subject = brief.subject ?? {};
  const claims = (ledger.claims ?? []) as Dict[];
  const byClass = new Map<string, number>();
  for (const c of claims) byClass.set(c.class, (byClass.get(c.class) ?? 0) + 1);
  const mix = [...byClass.entries()].map(([k, n]) => `${n} ${k}`).join(' · ');
  const chips = [
    subject.repo ? chip('Repo', subject.repo) : '',
    subject.homepage ? chip('Site', subject.homepage) : '',
    chip('Evidence', `${claims.length} claims — ${mix}`),
    brief.evidence?.acquired_at ? chip('Acquired', brief.evidence.acquired_at) : '',
    (subject.origins?.length ?? 0) > 1 ? chip('Origins', subject.origins.map((o: Dict) => o.id).join(' + ')) : '',
  ].filter(Boolean).join('');
  const lines = [`# ${subject.name}: what the evidence says`, '', `<div class="chips">${chips}</div>`, ''];
  if (subject.one_liner) lines.push(`**${subject.one_liner}**`, '');
  lines.push(
    `<div class="callout"><strong>How to read this.</strong> Every material statement links to a numbered claim in the evidence section — each claim carries a verbatim quote from an acquired source. Statements are labeled by kind (observed, inferred, proposed, unverified) and never stronger than their evidence. What could not be established is said plainly instead of papered over.</div>`,
    '',
  );
  return lines.join('\n');
}

function positioning(brief: Dict): string {
  const p = brief.positioning;
  if (!p) return '';
  const name = brief.subject?.name ?? 'it';
  const parts: string[] = [];
  if (p.target_customer && p.need) parts.push(`**For** ${p.target_customer} **who need** ${p.need},`);
  if (p.category) {
    const article = /^[aeiou]/i.test(p.category) ? 'an' : 'a';
    parts.push(`**${name}** is ${article} ${p.category}`);
  }
  if (p.key_benefit) parts.push(`**that delivers** ${p.key_benefit}.`);
  if (p.alternative && p.differentiation) {
    parts.push(`**Unlike** ${p.alternative}, ${p.differentiation}.`);
  }
  if (parts.length === 0) return '';
  return `## What it is\n\n${parts.join(' ')}${cites(p.claims)}\n`;
}

function valueMap(brief: Dict): string {
  const rows = (brief.value_map ?? []) as Dict[];
  if (rows.length === 0) return '';
  const cards = rows.map((r) => {
    const proof = r.proof ? `<p><em>Check it: ${r.proof}.</em>${cites(r.claims)}</p>` : `<p>${cites(r.claims)}</p>`;
    return `<div class="card"><h3>${r.attribute}</h3><p>${r.value}.</p>${proof}</div>`;
  }).join('\n');
  return `## What that gets you\n\n<div class="cards">\n${cards}\n</div>\n`;
}

function jobStories(brief: Dict): string {
  const rows = (brief.job_stories ?? []) as Dict[];
  if (rows.length === 0) return '';
  const items = rows.map((r) =>
    `- When ${r.situation}, I want ${r.motivation} — so I can ${r.outcome}.${cites(r.claims)}`
  ).join('\n');
  return `## In a user's words\n\n${items}\n`;
}

function siteInventory(brief: Dict): string {
  const rows = (brief.site_inventory ?? []) as Dict[];
  if (rows.length === 0) return '';
  const body = rows.map((r) =>
    `| \`${r.locator}\` | ${r.page_type} | ${r.disposition ?? '—'} | ${r.rationale ?? '—'}${cites(r.claims)} |`
  ).join('\n');
  return `## Public surface, page by page\n\n| page | type | verdict | why |\n| --- | --- | --- | --- |\n${body}\n`;
}

function cannotVerify(brief: Dict): string {
  const rows = (brief.cannot_verify ?? []) as Dict[];
  if (rows.length === 0) return '';
  const items = rows.map((r) => `- **${r.what}** — ${r.why}.`).join('\n');
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

function evidence(brief: Dict, ledger: Dict): string {
  const claims = (ledger.claims ?? []) as Dict[];
  if (claims.length === 0) return '';
  const blocks = claims.map((c) => {
    const badge = `<span class="chip"><strong>${c.class}</strong> ${c.confidence}</span>`;
    const derived = (c.derived_from ?? []).length
      ? ` <em>inferred from ${(c.derived_from as string[]).map(link).join(', ')}</em>`
      : '';
    const sources = ((c.sources ?? []) as Dict[]).map((s) =>
      `> "${s.quote}"\n> — \`${s.locator}\`, as of ${s.as_of}`
    ).join('\n>\n');
    return `<span id="${String(c.id).toLowerCase()}"></span>**${c.id}** ${badge} — ${c.statement}${derived}\n\n${sources}`;
  }).join('\n\n');
  const acq = ((brief.evidence?.acquisition ?? []) as Dict[])
    .map((a) => `\`${a.tool}\` → ${a.target} (${a.retrieved_at})`).join(' · ');
  const provenance = acq ? `\nAcquired with: ${acq}.\n` : '';
  return `## The evidence, claim by claim\n\n${blocks}\n${provenance}`;
}

export function renderBrief(dir: string): string {
  const brief = Bun.YAML.parse(readFileSync(join(dir, 'brief.yaml'), 'utf-8')) as Dict;
  const ledger = Bun.YAML.parse(readFileSync(join(dir, 'ledger.yaml'), 'utf-8')) as Dict;
  const sections = [
    header(brief, ledger),
    positioning(brief),
    valueMap(brief),
    jobStories(brief),
    siteInventory(brief),
    cannotVerify(brief),
    findings(dir),
    evidence(brief, ledger),
  ];
  return sections.filter(Boolean).join('\n');
}

if (import.meta.main) {
  const [dir, outFlag, outPath] = process.argv.slice(2);
  if (!dir || (outFlag && outFlag !== '--out')) {
    console.error('usage: render.ts <intelligence-dir> [--out <file>]');
    process.exit(2);
  }
  const page = renderBrief(dir);
  const target = outPath ?? join(dir, 'brief-page.md');
  writeFileSync(target, page);
  console.log(target);
}

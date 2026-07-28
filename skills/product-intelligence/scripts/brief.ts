// What a brief MEANS, read once for both renderings. The doc page and the deck
// answer the same questions in different voices; a rule restated per voice is a
// rule the two lanes can disagree about.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Dict = Record<string, any>;

// Markdown containers — table rows, list items — are line-structured, so the
// deck voice collapses a field to one line. HTML has no such seam.
export function collapse(value: unknown): string {
  return String(value ?? '').replace(/\s*[\r\n]\s*/g, ' ');
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function missingTerminalPeriod(value: unknown): string {
  return /[.!?]$/.test(String(value ?? '').trim()) ? '' : '.';
}

export function artifacts(dir: string): { brief: Dict; ledger: Dict } {
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

export function subjectTitle(brief: Dict): string {
  return `${collapse(brief.subject?.name ?? 'Untitled product')}: what the evidence says`;
}

// A dangling or self-referential target would render an empty bold span and a
// dead anchor. Neither renderer validates, so unvalidated input reaches here;
// drop the pair rather than print a broken row. Dedupe runs on positions, never
// on ids joined by a delimiter: an id carrying that delimiter split back into
// two ids matching no claim, and the consumers dereferenced undefined.
export function contradictionPairs(ledger: Dict): Array<[Dict, Dict]> {
  const claims = (ledger.claims ?? []) as Dict[];
  const indexById = new Map<string, number>();
  claims.forEach((c, i) => indexById.set(c.id, i));
  const seen = new Set<string>();
  const pairs: Array<[Dict, Dict]> = [];
  for (const [self, c] of claims.entries()) {
    for (const other of (c.contradicts ?? []) as string[]) {
      const target = indexById.get(other);
      if (other === c.id || target === undefined || target === self) continue;
      const key = self < target ? `${self}:${target}` : `${target}:${self}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Ordered by id so a pair reads the same whichever side declared it.
      const [one, two] = [c, claims[target]];
      pairs.push(String(one.id) <= String(two.id) ? [one, two] : [two, one]);
    }
  }
  return pairs;
}

// How a lane escapes a field and how it emphasises one. Moore's slot
// composition below is the same sentence either way.
export interface Voice {
  esc(value: unknown): string;
  strong(html: string): string;
}

// Moore's six slots are all optional, so compose only complete thoughts: a
// half-filled slot set must read as a short sentence, never as a fragment
// ending in a comma — and no slot may be silently dropped.
export function positioningSentences(brief: Dict, voice: Voice): string[] {
  const p = brief.positioning;
  if (!p) return [];
  const { esc, strong } = voice;
  const name = esc(brief.subject?.name ?? 'It');
  const sentences: string[] = [];
  const lead = p.target_customer && p.need
    ? `${strong('For')} ${esc(p.target_customer)} ${strong('who need')} ${esc(p.need)}`
    : '';
  const subject = p.category
    ? `${strong(name)} is ${/^[aeiou]/i.test(p.category) ? 'an' : 'a'} ${esc(p.category)}`
    : strong(name);
  const benefit = p.key_benefit ? ` that delivers ${esc(p.key_benefit)}` : '';
  if (lead || p.category || p.key_benefit) sentences.push(`${lead ? `${lead}, ` : ''}${subject}${benefit}.`);
  if (p.alternative && p.differentiation) {
    sentences.push(`${strong('Unlike')} ${esc(p.alternative)}, ${esc(p.differentiation)}.`);
  } else if (p.alternative) {
    sentences.push(`The alternative it is measured against: ${esc(p.alternative)}.`);
  } else if (p.differentiation) {
    sentences.push(`What sets it apart: ${esc(p.differentiation)}.`);
  }
  if (!lead && p.need) sentences.push(`The need it answers: ${esc(p.need)}.`);
  if (!lead && p.target_customer) sentences.push(`Who it is for: ${esc(p.target_customer)}.`);
  return sentences;
}

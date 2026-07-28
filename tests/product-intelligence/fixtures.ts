// Artifact builders and the injection table shared by the doc and deck render
// suites. One table, one payload set: a second copy drifts, and a field only
// sampled in one renderer ships unsampled in the other.

export const minimalBrief = (extra: string) =>
  ["brief_version: '1.0'", 'subject: { name: acme }', 'evidence: { ledger: ledger.yaml }', extra].join('\n');

export const journalBrief = () => minimalBrief('positioning: { category: journal }');

export function ledgerWith(...claims: string[][]): string {
  const head = ["ledger_version: '1.0'", 'generated_by: t', "generated_at: '2026-07-28'", 'claims:'];
  return [...head, ...claims.flat()].join('\n');
}

export const claim = (
  id: string,
  statement: string,
  cls: string,
  confidence: string,
  sources: string[][] = [],
) => [
  `  - id: ${JSON.stringify(id)}`,
  `    statement: ${JSON.stringify(statement)}`,
  `    class: ${cls}`,
  `    confidence: ${confidence}`,
  ...(sources.length ? ['    sources:', ...sources.flat()] : []),
];

export const src = (locator: string, quote: string, stance: string) => [
  `      - locator: ${JSON.stringify(locator)}`,
  `        quote: ${JSON.stringify(quote)}`,
  `        stance: ${stance}`,
  "        as_of: '2026-07-28'",
];

// One payload per untrusted field: a sampled test lets a refactor reopen the
// injection on every field it does not sample. Each field carries a distinct
// marker so a surviving escape gap names itself.
export const FIELDS = [
  'name', 'one_liner', 'category', 'target_customer', 'need', 'key_benefit',
  'alternative', 'differentiation', 'vm_attribute', 'vm_value', 'vm_proof',
  'js_situation', 'js_motivation', 'js_outcome', 'wf_name', 'wf_step',
  'wf_description', 'si_locator', 'si_title', 'si_page_type', 'si_disposition',
  'si_rationale', 'cv_what', 'cv_why', 'statement', 'quote', 'locator',
  'acq_tool', 'acq_target', 'origin_id', 'origin_kind', 'origin_target',
  'claim_id', 'claim_id_b', 'statement_b', 'pos_claims', 'generated_at',
  'generated_by',
] as const;

// The marker itself must survive escaping unchanged, so it carries no markdown
// metacharacter of its own.
export const marker = (field: string) => field.replace(/_/g, '');

export const payload = (field: string) =>
  `<script>${marker(field)}</script>[x](javascript:alert(1))\n\n## forged ${marker(field)}`;

// Every block position findings.md can put author text in. The brief's fields
// have FIELDS; this is the same idea for the file whose structure we render —
// a position nothing samples is a position the next refactor can un-escape
// while the suite stays green.
export const FINDINGS_SITES = [
  'heading', 'para', 'bullet', 'ordered', 'loose', 'nested', 'quote',
  'th', 'td', 'fence', 'mermaid',
] as const;

const tag = (site: string) => `<img src=x onerror=alert(1)>${site}`;

export const findingsPayload = (site: string) => tag(site);

// One file carrying the payload at all of them at once: separate fixtures per
// position drift, and the cheap ones stop being written.
export function hostileFindings(): string {
  return [
    '# Findings',
    '',
    `## ${tag('heading')}`,
    '',
    tag('para'),
    '',
    `- ${tag('bullet')}`,
    `- outer`,
    `  - ${tag('nested')}`,
    '',
    `1. ${tag('ordered')}`,
    '',
    `- ${tag('loose')}`,
    '',
    '  second paragraph of a loose item',
    '',
    `> ${tag('quote')}`,
    '',
    `| ${tag('th')} | b |`,
    '| --- | --- |',
    `| ${tag('td')} | d |`,
    '',
    '```text',
    tag('fence'),
    '```',
    '',
    '```mermaid',
    `flowchart LR`,
    `  A[${tag('mermaid')}] --> B`,
    '```',
  ].join('\n');
}

// Markdown syntax is inert where the doc lane emits HTML, so the shapes that
// still matter there are the ones that reach for a tag, an attribute or a
// scheme. Each keeps the field's marker, so a surviving gap still names itself.
export const HOSTILE_SHAPES: Record<string, (field: string) => string> = {
  tag: payload,
  attribute: (f) => `" onmouseover="alert(1)" data-${marker(f)}="`,
  quote: (f) => `'><script>${marker(f)}</script>`,
  entity: (f) => `&lt;script&gt;${marker(f)}&lt;/script&gt;&#106;`,
  scheme: (f) => `javascript:alert(1)//${marker(f)}`,
  backslash: (f) => `C:\\Users\\${marker(f)}\\`,
};

export type Payload = (field: string) => string;

export function hostileBrief(make: Payload = payload): string {
  const y = (field: string) => JSON.stringify(make(field));
  return [
    "brief_version: '1.0'",
    'subject:',
    `  name: ${y('name')}`,
    `  one_liner: ${y('one_liner')}`,
    '  origins:',
    `    - id: ${y('origin_id')}`,
    `      kind: ${y('origin_kind')}`,
    `      target: ${y('origin_target')}`,
    'evidence:',
    '  ledger: ledger.yaml',
    '  acquisition:',
    `    - tool: ${y('acq_tool')}`,
    `      target: ${y('acq_target')}`,
    "      retrieved_at: '2026-07-28'",
    'positioning:',
    ...(['category', 'target_customer', 'need', 'key_benefit', 'alternative', 'differentiation'] as const)
      .map((k) => `  ${k}: ${y(k)}`),
    `  claims: [${y('pos_claims')}]`,
    'value_map:',
    `  - attribute: ${y('vm_attribute')}`,
    `    value: ${y('vm_value')}`,
    `    proof: ${y('vm_proof')}`,
    'job_stories:',
    `  - situation: ${y('js_situation')}`,
    `    motivation: ${y('js_motivation')}`,
    `    outcome: ${y('js_outcome')}`,
    'workflows:',
    `  - name: ${y('wf_name')}`,
    '    steps:',
    `      - step: ${y('wf_step')}`,
    `        description: ${y('wf_description')}`,
    'site_inventory:',
    `  - locator: ${y('si_locator')}`,
    `    title: ${y('si_title')}`,
    `    page_type: ${y('si_page_type')}`,
    `    disposition: ${y('si_disposition')}`,
    `    rationale: ${y('si_rationale')}`,
    'cannot_verify:',
    `  - what: ${y('cv_what')}`,
    `    why: ${y('cv_why')}`,
  ].join('\n');
}

export function hostileLedger(make: Payload = payload): string {
  const y = (field: string) => JSON.stringify(make(field));
  return [
    "ledger_version: '1.0'",
    `generated_by: ${y('generated_by')}`,
    `generated_at: ${y('generated_at')}`,
    'claims:',
    // Two claims in conflict: with one, the contradiction renderers never see
    // hostile input at all and their escaping is asserted by nothing.
    ...claim(make('claim_id'), make('statement'), 'observed', 'high', [
      src(make('locator'), make('quote'), 'supports'),
    ]),
    `    contradicts: [${y('claim_id_b')}]`,
    ...claim(make('claim_id_b'), make('statement_b'), 'observed', 'high'),
  ].join('\n');
}

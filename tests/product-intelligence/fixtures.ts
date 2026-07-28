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
  `  - id: ${id}`,
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
  'acq_tool', 'acq_target', 'origin_kind', 'generated_at', 'generated_by',
] as const;

// The marker itself must survive escaping unchanged, so it carries no markdown
// metacharacter of its own.
export const marker = (field: string) => field.replace(/_/g, '');

export const payload = (field: string) =>
  `<script>${marker(field)}</script>[x](javascript:alert(1))\n\n## forged ${marker(field)}`;

const y = (field: string) => JSON.stringify(payload(field));

export function hostileBrief(): string {
  return [
    "brief_version: '1.0'",
    'subject:',
    `  name: ${y('name')}`,
    `  one_liner: ${y('one_liner')}`,
    '  origins:',
    `    - { id: og, kind: ${y('origin_kind')}, target: t }`,
    'evidence:',
    '  ledger: ledger.yaml',
    '  acquisition:',
    `    - tool: ${y('acq_tool')}`,
    `      target: ${y('acq_target')}`,
    "      retrieved_at: '2026-07-28'",
    'positioning:',
    ...(['category', 'target_customer', 'need', 'key_benefit', 'alternative', 'differentiation'] as const)
      .map((k) => `  ${k}: ${y(k)}`),
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

export function hostileLedger(): string {
  return [
    "ledger_version: '1.0'",
    `generated_by: ${y('generated_by')}`,
    `generated_at: ${y('generated_at')}`,
    'claims:',
    ...claim('C-001', payload('statement'), 'observed', 'high', [
      src(payload('locator'), payload('quote'), 'supports'),
    ]),
  ].join('\n');
}

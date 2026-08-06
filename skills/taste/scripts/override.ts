export type Override =
  | { state: 'absent' }
  | { state: 'granted'; value: string }
  | { state: 'off'; value: string };

const OFF_VALUES = new Set(['', '0', 'false', 'no', 'off']);

export function unquote(value: string): string {
  return value.replace(/^(['"])(.*)\1$/, '$2');
}

// An override you can switch off by mistyping it is worse than none: the owner
// believes the guard is on. Empty, 0, false, no and off are therefore refusals
// that say so, never a quiet grant and never a quiet block.
export function readOverride(raw: string | undefined): Override {
  if (raw === undefined) return { state: 'absent' };
  const value = unquote(raw).trim();
  if (OFF_VALUES.has(value.toLowerCase())) return { state: 'off', value: raw };
  return { state: 'granted', value };
}

export function offValueLine(name: string, value: string): string {
  return `${name}=${JSON.stringify(value)} does not read as a deliberate override `
    + '(empty, 0, false, no and off switch nothing on)';
}

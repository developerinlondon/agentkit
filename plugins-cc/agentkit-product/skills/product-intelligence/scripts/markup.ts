// The page is HTML this renderer emits and nothing parses again, so one escape
// covers every position an untrusted value can land in — element content and
// attribute value alike.

const ENTITY: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ENTITY[c] as string);
}

// SSRF-safe fetching for the acquisition wrappers. Every hostname — the
// operator's target and every redirect hop — is resolved and checked against
// non-public address ranges before any request is sent.

import { lookup } from 'node:dns/promises';

export function parseIPv4(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

const V4_BLOCKED_CIDRS: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3], // multicast + reserved + broadcast in one stroke
];
const V4_BLOCKED: [number, number][] = V4_BLOCKED_CIDRS.map(([base, bits]) => [parseIPv4(base)!, bits]);

export function isBlockedIPv4(text: string): boolean {
  const value = parseIPv4(text);
  if (value === null) return true;
  return V4_BLOCKED.some(([base, bits]) => value >>> (32 - bits) === base >>> (32 - bits));
}

// Returns the address as 8 hextet values, or null when unparseable.
export function expandIPv6(text: string): number[] | null {
  let body = text;
  // Embedded IPv4 tail (::ffff:1.2.3.4) becomes two hextets.
  const v4tail = body.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4tail) {
    const value = parseIPv4(v4tail[2]);
    if (value === null) return null;
    body = `${v4tail[1]}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const toHextets = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    const out: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = toHextets(halves[0]);
  const tail = halves.length === 2 ? toHextets(halves[1]) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  if (head.length + tail.length > 7) return null;
  return [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail];
}

export function isBlockedIPv6(text: string): boolean {
  const h = expandIPv6(text);
  if (h === null) return true;
  // ::/96 covers ::, ::1 and the deprecated IPv4-compatible range in one go.
  if (h.slice(0, 6).every((x) => x === 0)) return true;
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  // Transition ranges smuggle an IPv4 address into IPv6; a public-looking
  // AAAA answer in any of them can still route to a private v4 target.
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return true; // ::ffff:0:0/96 v4-mapped
  if (h[0] === 0x64 && h[1] === 0xff9b) return true; // 64:ff9b::/96 NAT64
  if (h[0] === 0x2002) return true; // 2002::/16 6to4
  if (h[0] === 0x2001 && h[1] === 0x0000) return true; // 2001::/32 Teredo
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  return false;
}

export function isBlockedAddress(address: string): boolean {
  return address.includes(':') ? isBlockedIPv6(address) : isBlockedIPv4(address);
}

// Test-only escape hatch: exact hostnames, no wildcards. Production callers
// must never set it — an inherited value silently widens the SSRF boundary.
function allowedByOverride(hostname: string): boolean {
  const raw = process.env.SAFE_FETCH_ALLOW_HOSTS ?? '';
  return raw.split(',').map((h) => h.trim()).filter(Boolean).includes(hostname);
}

export async function assertHostAllowed(hostname: string): Promise<void> {
  if (allowedByOverride(hostname)) return;
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (bare === 'localhost' || bare.endsWith('.localhost')) {
    throw new Error(`refusing ${hostname}: loopback`);
  }
  if (parseIPv4(bare) !== null || bare.includes(':')) {
    if (isBlockedAddress(bare)) throw new Error(`refusing ${hostname}: non-public address`);
    return;
  }
  const answers = await lookup(bare, { all: true, verbatim: true });
  if (answers.length === 0) throw new Error(`refusing ${hostname}: does not resolve`);
  for (const { address } of answers) {
    if (isBlockedAddress(address)) {
      throw new Error(`refusing ${hostname}: resolves to non-public address ${address}`);
    }
  }
}

export interface SafeFetchResult {
  finalUrl: string;
  status: number;
  hops: string[];
  body: Uint8Array;
  contentType: string;
}

const MAX_HOPS = 5;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export async function safeFetch(target: string): Promise<SafeFetchResult> {
  let url = new URL(target);
  const hops: string[] = [];
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`refusing ${url.href}: only http(s) is fetched`);
    }
    await assertHostAllowed(url.hostname);
    hops.push(url.href);
    const response = await fetch(url.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': 'agentkit-product-intelligence' },
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    return {
      finalUrl: url.href,
      status: response.status,
      hops,
      body: await readCapped(response),
      contentType: response.headers.get('content-type') ?? '',
    };
  }
  throw new Error(`refusing ${target}: more than ${MAX_HOPS} redirects`);
}

async function readCapped(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      await response.body.cancel().catch(() => {});
      throw new Error(`response exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

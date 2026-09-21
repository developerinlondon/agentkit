// The System One provider agentkit ships with: one typed question, one
// probability back. The seam is the module boundary — a kind hands over state
// and instructions and reads a number, so a second provider is a second file.

export const TYPESAFE_BASE_URL = 'https://api.typesafe.ai';
export const TYPESAFE_TIMEOUT_MS = 8000;
const MODEL = 'jev-latest';

export interface NoulRequest {
  apiKey: string;
  baseUrl?: string;
  state: Record<string, string>;
  instructions: Record<string, string>;
  timeoutMs?: number;
}

export type NoulAnswer =
  | { ok: true; noul: number; model: string }
  | { ok: false; reason: string };

// The answer comes back under the key its question was asked under. Read by
// that key rather than by position: a future call asking several questions gets
// them in one object, and the first one is not the one this asked.
function noulOf(payload: unknown): number | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const answers = (payload as Record<string, unknown>).answers;
  if (typeof answers !== 'object' || answers === null) return undefined;
  const answer = (answers as Record<string, unknown>).q;
  const noul = typeof answer === 'number'
    ? answer
    : (answer as Record<string, unknown> | null)?.noul;
  // A noul is a probability. Anything outside that range is the vendor
  // answering a different question, and reading it as one would turn a
  // malformed response into a refusal.
  if (typeof noul !== 'number' || !Number.isFinite(noul) || noul < 0 || noul > 1) return undefined;
  return noul;
}

function modelOf(payload: unknown): string {
  const model = (payload as Record<string, unknown> | null)?.model;
  return typeof model === 'string' ? model : MODEL;
}

// No retry. This runs inside a hook the agent is waiting on, so a provider
// having a bad minute must cost the session one deadline, not three.
export async function askNoul(ask: NoulRequest): Promise<NoulAnswer> {
  const timeoutMs = ask.timeoutMs ?? TYPESAFE_TIMEOUT_MS;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${ask.baseUrl ?? TYPESAFE_BASE_URL}/v1/systemone`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${ask.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        state: ask.state,
        model: MODEL,
        questions: { q: { type: 'noul', instructions: ask.instructions } },
      }),
    });

    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };

    const payload = await response.json() as unknown;
    const noul = noulOf(payload);
    if (noul === undefined) return { ok: false, reason: 'it returned an unusable answer' };
    return { ok: true, noul, model: modelOf(payload) };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, reason: `timeout after ${timeoutMs}ms` };
    return { ok: false, reason: (error as Error).message };
  } finally {
    clearTimeout(deadline);
  }
}

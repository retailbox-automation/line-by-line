// The only place that can reach Groq. It refuses before any network call unless the run is explicitly live.

export const GROQ_BASE = "https://api.groq.com/openai/v1";
export const GROQ_TIMEOUT_MS = 20_000;

export class AgentError extends Error {
  override name = "AgentError";
}

/** Throws unless LBL_LLM_LIVE=1 and GROQ_API_KEY are set. Reads the environment at call time. */
export function groqKey(): string {
  if (process.env.LBL_LLM_LIVE !== "1") {
    throw new AgentError("Groq is a paid provider: set LBL_LLM_LIVE=1 to allow a live call (refused before any network use)");
  }
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new AgentError("GROQ_API_KEY is not set (refused before any network use)");
  return key;
}

/** Longest `retry-after` we wait for on a 429; a longer one fails the call at once. */
export const GROQ_RETRY_AFTER_MAX_S = 60;

/** Retries allowed after a 429 (LBL_GROQ_429_RETRIES, default 1; the benchmark sets more for the free tier's 8K tokens a minute). */
function retriesOn429(): number {
  const n = Number(process.env.LBL_GROQ_429_RETRIES ?? "1");
  return Number.isInteger(n) && n >= 0 && n <= 20 ? n : 1;
}

/** Seconds from a 429's `retry-after`, or null when it is missing, unreadable or above the ceiling. */
function retryAfterSeconds(res: Response): number | null {
  const s = Number(res.headers.get("retry-after"));
  return res.headers.has("retry-after") && Number.isFinite(s) && s >= 0 && s <= GROQ_RETRY_AFTER_MAX_S ? s : null;
}

/**
 * One POST to Groq with a 20 s timeout. On a 429 it waits what `retry-after` says (at most 60 s) and sends the same
 * request again, up to the allowed retries; nothing else is retried. Returns parsed JSON; errors never contain the key.
 */
export async function groqPost(path: string, body: string | FormData, contentType?: string): Promise<unknown> {
  const key = groqKey();
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  if (contentType) headers["content-type"] = contentType;
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${GROQ_BASE}${path}`, { method: "POST", headers, body, signal: AbortSignal.timeout(GROQ_TIMEOUT_MS) });
    } catch (e) {
      throw new AgentError(`Groq request to ${path} failed: ${e instanceof Error ? e.name : "unknown error"}`);
    }
    const wait = res.status === 429 && attempt < retriesOn429() ? retryAfterSeconds(res) : null;
    if (wait === null) break;
    await res.text();
    await new Promise((r) => setTimeout(r, Math.ceil(wait * 1000)));
  }
  const text = await res.text();
  if (!res.ok) throw new AgentError(`Groq ${path} answered ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new AgentError(`Groq ${path} answered ${res.status} with a body that is not JSON`);
  }
}

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

/** One POST to Groq with a 20 s timeout and no retries. Returns parsed JSON; errors never contain the key. */
export async function groqPost(path: string, body: string | FormData, contentType?: string): Promise<unknown> {
  const key = groqKey();
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  if (contentType) headers["content-type"] = contentType;
  let res: Response;
  try {
    res = await fetch(`${GROQ_BASE}${path}`, { method: "POST", headers, body, signal: AbortSignal.timeout(GROQ_TIMEOUT_MS) });
  } catch (e) {
    throw new AgentError(`Groq request to ${path} failed: ${e instanceof Error ? e.name : "unknown error"}`);
  }
  const text = await res.text();
  if (!res.ok) throw new AgentError(`Groq ${path} answered ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new AgentError(`Groq ${path} answered ${res.status} with a body that is not JSON`);
  }
}

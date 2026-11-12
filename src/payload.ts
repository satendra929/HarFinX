// Request hook: applies the reasoning-history policy of the active reasoning profile (src/reasoning.ts) to an
// OpenAI-style chat request and, for the one-off retry, adds the profile's "thinking off" fields.
// Why: the provider library sends each earlier assistant turn's reasoning back in the chat history. A local server's chat template may replay it into the prompt as text, and
// the model can then imitate it and put its final answer inside its reasoning: the user sees no answer text.
import type { ReasoningHistory } from "./reasoning.ts";

// Field names OpenAI-compatible servers use for reasoning on assistant messages.
const REASONING_FIELDS = ["reasoning", "reasoning_content", "reasoning_text", "reasoning_details"];

/**
 * The Agent `onPayload` hook. `history` is the policy for earlier reasoning (default "drop"); `noThink()` is read at
 * request time and, when true, `thinkingOff` (if the profile has one) is merged into that request.
 */
export function makePayloadHook(opts: { history?: ReasoningHistory; thinkingOff?: Record<string, unknown>; noThink?: () => boolean } = {}): (payload: unknown) => unknown {
  const history = opts.history ?? "drop";
  return (payload) => {
    const p: any = applyReasoningHistory(payload, history);
    return opts.noThink?.() && opts.thinkingOff && p && typeof p === "object" ? { ...p, ...opts.thinkingOff } : p;
  };
}

/**
 * Returns a copy of an OpenAI-style chat payload with earlier reasoning handled per policy: "keep" changes nothing,
 * "drop" removes the reasoning fields of every assistant message, "latest" removes them from all but the most recent
 * assistant message of the current question. Other fields and other roles are untouched; payloads of another shape
 * are returned as they are. Limits: this knows the OpenAI-compatible field names only; a provider library that sends
 * reasoning back as ordinary message text, or content-block providers, are not changed by "drop"/"latest".
 */
export function applyReasoningHistory<T>(payload: T, history: ReasoningHistory): T {
  const p = payload as any;
  if (history === "keep" || !p || !Array.isArray(p.messages)) return payload;
  // "latest" means the step the model is in the middle of: the last assistant message, and only when it comes after
  // the last user message. The reasoning behind a previous question's answer is never kept.
  const lastUser = p.messages.map((m: any) => m?.role === "user").lastIndexOf(true);
  const lastAssistantAny = p.messages.map((m: any) => m?.role === "assistant").lastIndexOf(true);
  const lastAssistant = lastAssistantAny > lastUser ? lastAssistantAny : -1;
  return {
    ...p,
    messages: p.messages.map((m: any, i: number) => {
      if (!m || m.role !== "assistant" || (history === "latest" && i === lastAssistant)) return m;
      const copy = { ...m };
      for (const f of REASONING_FIELDS) delete copy[f];
      return copy;
    }),
  };
}

/** Returns a copy of an OpenAI-style chat payload without reasoning fields on assistant messages ("drop"). */
export function stripHistoryReasoning<T>(payload: T): T {
  return applyReasoningHistory(payload, "drop");
}

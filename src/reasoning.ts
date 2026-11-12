// Reasoning ("thinking") profile: the ONE place that holds provider/model-specific knowledge about reasoning.
// Everything else keys off observable symptoms (a finished reply without answer text, a looping reply) and works for
// any provider or model. To support a new provider or model family: add or adjust an entry here, then re-check that
// final replies still contain answer text with each history policy (REASONING_HISTORY).
import type { Provider } from "./config.ts";

/**
 * What happens to the reasoning of EARLIER replies when the conversation is sent back to the model:
 * - "drop":   never sent back. Safest for local models whose chat template replays it as text the model can imitate.
 * - "latest": only the reasoning of the most recent reply within the current question is sent back (the step the
 *             model is in the middle of); never the reasoning behind an earlier question's answer.
 * - "keep":   sent back as the provider library builds it (the server or its chat template decides what the model sees).
 */
export const REASONING_HISTORY = ["drop", "latest", "keep"] as const;
export type ReasoningHistory = (typeof REASONING_HISTORY)[number];

export interface ReasoningProfile {
  history: ReasoningHistory;
  /** False when the provider's API requires earlier reasoning to be returned unchanged (signed blocks): no override. */
  historyAdjustable: boolean;
  /**
   * Extra top-level request fields that switch thinking off. They are sent only during the one retry after a reply
   * without an answer or a looping reply, for every request of that retry (it may include tool turns).
   * Undefined: the provider has no such switch here, and the retry is a plain second attempt.
   */
  thinkingOff?: Record<string, unknown>;
}

const PROFILES: Record<Provider, ReasoningProfile> = {
  // Some local reasoning models answer inside their reasoning when earlier reasoning is replayed to them, so the
  // default is not to replay it. `reasoning_effort: "none"` is Ollama's
  // OpenAI-compatible switch for thinking; models without a thinking capability ignore it.
  ollama: { history: "drop", historyAdjustable: true, thinkingOff: { reasoning_effort: "none" } },
  // Anthropic requires thinking blocks (signed) to be passed back unchanged while tools are in use.
  anthropic: { history: "keep", historyAdjustable: false },
};

/**
 * Per-model-family differences within a provider (matched on the start of the model tag).
 * Gemma on Ollama: `reasoning_effort: "none"` is not used, because switching thinking off can make this family
 * return an empty reply after a tool result. The one retry is a plain second attempt instead.
 */
const FAMILY_PROFILES: { provider: Provider; prefix: RegExp; profile: ReasoningProfile }[] = [
  { provider: "ollama", prefix: /^gemma/i, profile: { history: "drop", historyAdjustable: true } },
];

/**
 * The profile for a provider (and, optionally, the model in use), with an optional override of the history policy
 * (env REASONING_HISTORY).
 */
export function reasoningProfile(provider: Provider, historyOverride?: ReasoningHistory, modelId?: string): ReasoningProfile {
  const family = modelId ? FAMILY_PROFILES.find((f) => f.provider === provider && f.prefix.test(modelId)) : undefined;
  const base = family?.profile ?? PROFILES[provider];
  if (historyOverride === undefined || historyOverride === base.history) return base;
  if (!base.historyAdjustable) {
    throw new Error(`REASONING_HISTORY=${historyOverride} is not supported for PROVIDER=${provider}: its API needs earlier reasoning returned unchanged ("${base.history}").`);
  }
  return { ...base, history: historyOverride };
}

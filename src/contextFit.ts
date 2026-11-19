// Warns when a prompt is close to the model's context window. The model server (Ollama) cuts a prompt that does not
// fit without saying so, and the oldest text, which can include instructions, is what goes. Reports only; changes nothing.

/** Share of the window at which a prompt counts as "near the limit". */
export const NEAR_LIMIT = 0.95; // owner, 2026-11-19: was 0.8 (reading three pages per question uses about 65% of a 16k window)

export interface TokenUsage {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
}

/** Prompt size of one model call: the reported input plus any cached part of the prompt. */
export function promptTokens(usage: TokenUsage | undefined): number {
  return (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
}

export interface ContextWarning {
  used: number;
  window: number;
  text: string;
}

export interface ContextMeter {
  percent: number;
  /** At or past the near-limit share: the caller shows it as a warning. */
  high: boolean;
  text: string;
}

/**
 * How full the conversation is after a question: the last call's prompt plus the reply it wrote, which is about what
 * the next question starts from. Undefined when there is no usable figure. `chat` adds the way out (/new).
 */
export function contextMeter(usage: TokenUsage | undefined, window: number, chat = false): ContextMeter | undefined {
  const used = promptTokens(usage) + (usage?.output ?? 0);
  if (!(window > 0) || !(used > 0)) return undefined;
  const percent = Math.min(999, Math.round((100 * used) / window));
  const high = used >= NEAR_LIMIT * window;
  return {
    percent,
    high,
    text: high ? `context ${percent}%: near the limit${chat ? "; /new starts a fresh conversation" : ""}` : `context ${percent}%`,
  };
}

/** A warning when the call's prompt used at least NEAR_LIMIT of the window; otherwise undefined. */
export function contextWarning(usage: TokenUsage | undefined, window: number): ContextWarning | undefined {
  const used = promptTokens(usage);
  if (!(window > 0) || used < NEAR_LIMIT * window) return undefined;
  return {
    used,
    window,
    text: `[context] this step's prompt used ${used} of ${window} tokens. Near the limit the model server can silently drop the oldest text; ask a narrower question, or raise the context window.`,
  };
}

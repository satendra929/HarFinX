// Safety net, independent of root cause and of the model (see src/payload.ts): if a
// reply finishes with NO answer text and no tool call, the user would see nothing. Discard that reply and ask once more
// with thinking switched off (when the reasoning profile has such a switch; otherwise it is a plain second attempt).
import type { Agent } from "@earendil-works/pi-agent-core";

/** How a finished reply failed to answer: it holds only reasoning, or nothing at all. */
export type Answerless = "reasoning_only" | "empty";

/**
 * Classifies the last message when it is a finished assistant reply (ended normally or ran out of output tokens) that
 * has neither answer text nor a tool call. Returns undefined for every other message, including errors and aborts.
 */
export function answerlessReply(messages: readonly any[]): Answerless | undefined {
  const m = messages.at(-1);
  if (!m || m.role !== "assistant" || (m.stopReason !== "stop" && m.stopReason !== "length")) return undefined;
  const blocks: any[] = m.content ?? [];
  const hasText = blocks.some((b) => b.type === "text" && String(b.text).trim() !== "");
  const hasCall = blocks.some((b) => b.type === "toolCall");
  if (hasText || hasCall) return undefined;
  return blocks.some((b) => b.type === "thinking" && String(b.thinking).trim() !== "") ? "reasoning_only" : "empty";
}

/** The reasoning text of the last message (for the labelled fallback when even the retry yields no text). */
export function lastReasoning(messages: readonly any[]): string {
  const m = messages.at(-1);
  return (m?.content ?? []).filter((b: any) => b.type === "thinking").map((b: any) => b.thinking).join("\n").trim();
}

/**
 * Discards the last (bad) reply and continues once with thinking switched off. The flag is always switched back,
 * even if the retry throws. Used for replies without an answer and for runaway replies.
 */
export async function retryWithoutThinking(agent: Agent, setNoThink: (on: boolean) => void): Promise<void> {
  agent.state.messages = agent.state.messages.slice(0, -1);
  setNoThink(true);
  try {
    await agent.continue();
  } finally {
    setNoThink(false);
  }
}

/** Retries a reply without an answer once. Returns false (and does nothing) when the last message is not one. */
export async function repairAnswerless(agent: Agent, setNoThink: (on: boolean) => void): Promise<boolean> {
  if (!answerlessReply(agent.state.messages)) return false;
  await retryWithoutThinking(agent, setNoThink);
  return true;
}

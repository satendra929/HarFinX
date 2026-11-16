// Protection against a reply that loops, for any model. Two cases: (1) one reply repeats the same tool calls over and
// over; (2) one reply keeps generating far beyond the output cap when the server does not enforce it.
// Tools only run after a reply completes, so the per-question call cap cannot see (1), and nothing else sees (2).
// This watches the reply while it streams and cuts it off.
import type { Agent } from "@earendil-works/pi-agent-core";

export const MAX_IDENTICAL_CALLS = 3;
/** Size cap per output-cap token: about 1.5 times the typical 4 characters per token, so a legitimate reply at the cap is not cut. */
export const REPLY_CHARS_PER_CAP_TOKEN = 6;

/** Characters of reasoning, text and tool-call arguments in a (possibly still streaming) reply. */
export function replyChars(content: readonly any[] | undefined): number {
  let n = 0;
  for (const b of content ?? []) {
    if (b?.type === "thinking") n += String(b.thinking ?? "").length;
    else if (b?.type === "text") n += String(b.text ?? "").length;
    else if (b?.type === "toolCall") n += JSON.stringify(b.arguments ?? {}).length;
  }
  return n;
}

/** Why this (possibly still streaming) reply is a runaway, or undefined if it looks normal. */
export function detectRunaway(content: readonly any[] | undefined, maxCalls: number, maxIdentical = MAX_IDENTICAL_CALLS, maxChars = Infinity): string | undefined {
  const calls = (content ?? []).filter((b) => b?.type === "toolCall");
  if (calls.length > maxCalls) return `${calls.length} tool calls in one reply (limit ${maxCalls})`;
  // The last block may still be streaming (partial arguments), so repeat detection only looks at finished blocks.
  const seen = new Map<string, number>();
  for (const c of calls.slice(0, -1)) {
    const key = `${c.name}\0${JSON.stringify(c.arguments ?? {})}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n >= maxIdentical) return `the same ${c.name} call repeated ${n} times in one reply`;
  }
  if (maxChars !== Infinity && replyChars(content) > maxChars) return `one reply longer than ${maxChars} characters`;
  return undefined;
}

/**
 * Aborts the in-flight request as soon as a streaming reply is a runaway and reports why. Nothing from that reply runs:
 * tool calls execute only after a reply completes. `maxChars` (optional, a number or a function read for each reply)
 * caps the size of one reply. Returns the unsubscribe function.
 */
export function guardRunaway(agent: Agent, maxCalls: number, onRunaway: (reason: string) => void, maxChars: number | (() => number) = Infinity): () => void {
  let fired = false;
  return agent.subscribe((e) => {
    if (e.type === "message_start") fired = false; // a new reply
    if (e.type !== "message_update" || fired || (e.message as any).role !== "assistant") return;
    const reason = detectRunaway((e.message as any).content, maxCalls, MAX_IDENTICAL_CALLS, typeof maxChars === "function" ? maxChars() : maxChars);
    if (!reason) return;
    fired = true;
    onRunaway(reason);
    agent.abort();
  });
}

// Holding the model's text until a reply ends, and telling an answer from a draft. A reply that ends in a tool call is
// working text (a draft the next reply may correct): it is never shown, but the audit log keeps it. Only a reply
// without a tool call is the answer. Pure: no I/O.

export type ReplyKind = "partial" | "working" | "answer";

interface ReplyLike {
  stopReason?: string;
  content?: readonly any[];
}

/**
 * What a finished reply is, checked in this order:
 *  1. aborted or error (Ctrl+C, a runaway cut, a failed request): partial. Its text is shown as it is, even when the
 *     reply had tool calls: a loop of repeated calls or a stop after a call began must not be hidden.
 *  2. it has a tool call (or ends because of one): working text, not shown.
 *  3. everything else (stop, length, and any other reason): the answer.
 */
export function classifyReply(m: ReplyLike): ReplyKind {
  if (m.stopReason === "aborted" || m.stopReason === "error") return "partial";
  if (m.stopReason === "toolUse" || (m.content ?? []).some((b) => b?.type === "toolCall")) return "working";
  return "answer";
}

/** A user message the harness sent inside the question (the figure repair): it does not start a question. */
export const isRepairMessage = (m: unknown): boolean => (m as { harness?: string } | undefined)?.harness === "repair";

/** The text of the last reply of the current question that is an answer: what the user is shown as the answer, without any mark. */
export function finalAnswerText(messages: readonly unknown[]): string {
  const list = messages as { role?: string; content?: unknown; stopReason?: string }[];
  let lastUser = -1;
  list.forEach((m, i) => {
    if (m?.role === "user" && !isRepairMessage(m)) lastUser = i;
  });
  const answers = list.slice(lastUser + 1).filter((m) => m?.role === "assistant" && Array.isArray(m.content) && classifyReply(m as ReplyLike) === "answer");
  return answers
    .slice(-1) // a question has one answer; after a repair it is the last one
    .flatMap((m) => m.content as { type?: string; text?: unknown }[])
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

/** The text of the reply that is streaming now. It is never reset when a reply starts: only taking it empties it. */
export class ReplyHold {
  private text = "";
  push(delta: string): void {
    this.text += delta;
  }
  /** The held text, and the hold is empty again. */
  take(): string {
    const t = this.text;
    this.text = "";
    return t;
  }
  get length(): number {
    return this.text.length;
  }
}

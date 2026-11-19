// Run-level limits for tool use. Path confinement lives in workspace.ts, not here.
// Wiring: guard.beforeToolCall / afterToolCall go to the Agent, guard.attach(agent) feeds it the agent's events (replies and
// tool-call starts) and aborts a stopped question, and the CLI calls startRun() before each prompt.
// (Unknown/invalid tool calls never reach beforeToolCall, so the cap counts start events instead.)
import type { AfterToolCallContext, AfterToolCallResult, AgentEvent, BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";

/** Structured record of a guard decision, for the audit log. Tool arguments are logged by tool_start, not here. */
export type GuardEvent =
  | { kind: "call"; n: number; max: number; tool: string }
  | { kind: "tripped"; reason: string }
  | { kind: "blocked"; tool: string; reason: string }
  | { kind: "truncated"; tool: string; maxChars: number; originalChars: number }
  /** The call repeats an earlier successful one of this question and is not run; `free` when it was not counted against the call limit. */
  | { kind: "repeat"; tool: string; free: boolean };

export interface GuardOptions {
  maxCallsPerRun: number;
  maxOutputChars: number; // per tool result
  maxTotalChars: number; // across all tool results in one run
  log: (line: string) => void;
  onEvent?: (event: GuardEvent) => void;
  /** Tools whose small, pure output must keep working after the output budget is spent (the calculator). */
  budgetExempt?: string[];
  /**
   * Names a call so that two calls with the same key would return the same result (src/callKey.ts); undefined means the call
   * is never a repeat. When given, a call whose key is that of an earlier call that ran without error in this question is not
   * run. Without it nothing is treated as a repeat.
   */
  callKey?: (name: string, args: unknown) => string | undefined;
}

/** Repeats per question that are refused without counting against the call limit; later ones count like any call, so a loop still ends. */
export const MAX_FREE_REPEATS = 2;

// Sized for an 8k-token window (numbers tokenise at ~2-3 chars/token). The default window is 16k, so these are tighter than
// they need to be there; they do not yet scale with the window.
export const DEFAULT_LIMITS = { maxCallsPerRun: 8, maxOutputChars: 5_000, maxTotalChars: 20_000 }; // 2026-11-19: total was 12,000; three pages (about 4,000 characters each) plus the outline and a search need more

// Model-controlled text must not reach the terminal raw (ANSI escapes etc.).
export function safeForLog(value: unknown, max = 200): string {
  let s: string;
  try {
    s = JSON.stringify(value) ?? String(value);
  } catch {
    s = String(value);
  }
  s = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// Model-controlled text streamed to the terminal: drop escape codes and other control characters
// (keeps \n and \t) so it cannot recolour, move the cursor or overwrite output. This also means only
// the harness can produce coloured [guard] lines. A split escape sequence is harmless: ESC itself is replaced.
// A carriage return is dropped (CRLF line ends are common; a bare CR would overwrite the line), and invisible format
// characters (bidi overrides, zero-width marks, BOM) and line or paragraph separators are removed, as `oneLine` does.
export function cleanForTerminal(s: string): string {
  return s.replace(/\r/g, "").replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "?");
}

/**
 * What the model is told when a call is refused. No digits on purpose: the model may repeat it, and a number that is in
 * no source would show up as untraced in the [check] line. The numbers go to the user line and the audit log instead.
 */
export const ANSWER_NOW =
  "No more tool calls are available for this question. Answer now from what you have already read, use calculate for any arithmetic, and say what you could not find.";

/** What the model is told when a call repeats an earlier one. No digits, for the same reason as ANSWER_NOW. */
export const REPEATED_CALL =
  "This is the same call as one already made in this question, so it would return the same result and was not run. Use that earlier result, or make a different call (other words, another page, another file; a year or date in a search makes no difference), or answer from what you have read.";

export function createGuard(opts: GuardOptions) {
  const done = new Set<string>(); // keys of the calls of this question that ran without error
  let freeRepeats = 0;
  let calls = 0;
  let totalChars = 0;
  let tripped: string | undefined;
  let blockedBy: string | undefined; // why the first call of this question was refused, if one was
  let reply = 0; // model replies seen in this question (the CLI calls onReply() after each one)
  let softReply: number | undefined; // the reply whose calls were first refused

  const exempt = (name: string) => !!opts.budgetExempt?.includes(name);
  // The calculator may still run over the call limit (the model is told to use it), but never past twice the limit.
  const callsOver = (name: string) => calls > opts.maxCallsPerRun * 2 || (calls > opts.maxCallsPerRun && !exempt(name));

  function trip(reason: string, name: string): void {
    if (tripped) return;
    tripped = reason;
    opts.log(`stopping this question: ${reason}; the call to ${safeForLog(name, 60)} is not run`);
    opts.onEvent?.({ kind: "tripped", reason });
  }

  /**
   * A call was refused. The first time (any calls of the same reply) it is a soft stop: the call gets ANSWER_NOW as its
   * result and the model gets one more reply to answer. A refusal in a later reply means the model ignored that, or the
   * call count is past twice the limit: the question is stopped.
   */
  function refuse(reason: string, name: string): void {
    blockedBy ??= reason;
    softReply ??= reply;
    if (reply !== softReply || calls > opts.maxCallsPerRun * 2) trip(reason, name);
  }

  /** The model finished a reply (its tool calls, if any, start after this). Lets the guard tell one reply's calls from the next reply's. */
  function onReply(): void {
    reply++;
  }

  const isRepeat = (name: string, args: unknown): boolean => {
    const key = opts.callKey?.(name, args);
    return !!key && done.has(key);
  };

  function onToolStart(name: string, args?: unknown): void {
    // A repeat of an earlier call is not run (beforeToolCall); the first few do not count against the limit, but only while
    // the limit is not passed: past it a repeat counts like any call, so the soft and hard stop see it.
    if (!tripped && isRepeat(name, args)) {
      const free = freeRepeats < MAX_FREE_REPEATS && !callsOver(name);
      opts.onEvent?.({ kind: "repeat", tool: name, free });
      if (free) {
        freeRepeats++;
        opts.log(`not run: ${safeForLog(name, 60)} was already called the same way in this question`);
        return;
      }
    }
    calls++;
    opts.onEvent?.({ kind: "call", n: calls, max: opts.maxCallsPerRun, tool: name });
    // Counted here, not in beforeToolCall: an unknown tool name never reaches that hook.
    if (!tripped && callsOver(name)) refuse(`tool-call limit reached (${opts.maxCallsPerRun} per question)`, name);
  }

  return {
    startRun(): void {
      done.clear();
      freeRepeats = 0;
      calls = 0;
      totalChars = 0;
      tripped = undefined;
      blockedBy = undefined;
      reply = 0;
      softReply = undefined;
    },

    onReply,
    onToolStart,

    /**
     * Wires the guard to an agent: counts replies and tool calls, and aborts the run as soon as the question is stopped, at
     * a call's start (a call over the limit) and at a call's end (a refusal inside a batch whose other calls ran). Subscribe it
     * before any listener that reads `tripped`. The CLI and the tests both use this, so they cannot wire it differently.
     */
    attach(agent: { subscribe(listener: (e: AgentEvent) => void): unknown; abort(): void }): void {
      agent.subscribe((e) => {
        if (e.type === "message_end" && e.message.role === "assistant") onReply();
        else if (e.type === "tool_execution_start") onToolStart(e.toolName, e.args);
        if ((e.type === "tool_execution_start" || e.type === "tool_execution_end") && tripped) agent.abort(); // blocking alone lets the model keep calling
      });
    },

    /** Why a tool call of this question was refused (a limit, not a failure), if any. */
    get blocked(): string | undefined {
      return blockedBy;
    },

    /** Why the run must stop, if a limit was hit. */
    get tripped(): string | undefined {
      return tripped;
    },

    /** How many tool calls this question has started. Routine calls are not logged here (the CLI shows them as dim lines); only limits are. */
    get calls(): number {
      return calls;
    },

    async beforeToolCall(ctx: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> {
      const name = ctx.toolCall.name;
      let reason = tripped;
      if (!reason && callsOver(name)) reason = `tool-call limit reached (${opts.maxCallsPerRun} per question)`; // already counted in onToolStart
      else if (!reason && totalChars >= opts.maxTotalChars && !exempt(name)) {
        reason = `tool output limit reached (${opts.maxTotalChars} characters per question)`;
        refuse(reason, name);
      }
      // A repeat is neither a limit nor a failure: the model is told to use the earlier result (blockedBy stays unset, so no budget note).
      if (!reason && isRepeat(name, ctx.toolCall.arguments)) return { block: true, reason: REPEATED_CALL };
      if (!reason) return undefined;
      blockedBy ??= reason;
      opts.log(`blocked ${safeForLog(name, 60)}: ${reason}`);
      opts.onEvent?.({ kind: "blocked", tool: name, reason });
      // A soft stop lets the loop go on, so the model can answer; a stopped question ends the batch.
      return { block: true, reason: ANSWER_NOW, ...(tripped ? { terminate: true } : {}) };
    },

    async afterToolCall(ctx: AfterToolCallContext): Promise<AfterToolCallResult | undefined> {
      // Only a call that ran and did not fail is remembered (a blocked call never gets here; a failed one may be tried again).
      if (!ctx.isError) {
        const key = opts.callKey?.(ctx.toolCall?.name, ctx.toolCall?.arguments); // the call's own arguments, as at its start: the three keys cannot differ
        if (key) done.add(key);
      }
      let truncated = false;
      const content = ctx.result.content.map((part) => {
        if (part.type !== "text") return part;
        let text = part.text;
        if (text.length > opts.maxOutputChars) {
          opts.log(`${safeForLog(ctx.toolCall?.name, 60)} result cut at ${opts.maxOutputChars} of ${text.length} characters`);
          opts.onEvent?.({ kind: "truncated", tool: ctx.toolCall?.name, maxChars: opts.maxOutputChars, originalChars: text.length });
          text = text.slice(0, opts.maxOutputChars) + `\n[output truncated at ${opts.maxOutputChars} characters]`;
          truncated = true;
        }
        if (!opts.budgetExempt?.includes(ctx.toolCall?.name)) totalChars += text.length;
        return { ...part, text };
      });
      // Replacing the content would drop the structured content (Pi assumes it no longer matches), so it is passed along. It describes the uncut text, as the ledger always has.
      return truncated ? { content, ...(ctx.result.structuredContent !== undefined ? { structuredContent: ctx.result.structuredContent } : {}) } : undefined;
    },
  };
}

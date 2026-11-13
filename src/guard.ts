// Run-level limits for tool use. Path confinement lives in workspace.ts, not here.
// Wiring: guard.beforeToolCall / afterToolCall go to the Agent; the CLI calls startRun() before each
// prompt and feeds tool_execution_start events to onToolStart(), aborting the run if `tripped` is set.
// (Unknown/invalid tool calls never reach beforeToolCall, so the cap counts start events instead.)
import type { AfterToolCallContext, AfterToolCallResult, BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";

/** Structured record of a guard decision, for the audit log. Tool arguments are logged by tool_start, not here. */
export type GuardEvent =
  | { kind: "call"; n: number; max: number; tool: string }
  | { kind: "tripped"; reason: string }
  | { kind: "blocked"; tool: string; reason: string }
  | { kind: "truncated"; tool: string; maxChars: number; originalChars: number };

export interface GuardOptions {
  maxCallsPerRun: number;
  maxOutputChars: number; // per tool result
  maxTotalChars: number; // across all tool results in one run
  log: (line: string) => void;
  onEvent?: (event: GuardEvent) => void;
  /** Tools whose small, pure output must keep working after the output budget is spent (the calculator). */
  budgetExempt?: string[];
}

// Sized for a local model with an 8k-token window (numbers tokenise at ~2-3 chars/token).
export const DEFAULT_LIMITS = { maxCallsPerRun: 8, maxOutputChars: 5_000, maxTotalChars: 12_000 };

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
export function cleanForTerminal(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "?");
}

export function createGuard(opts: GuardOptions) {
  let calls = 0;
  let totalChars = 0;
  let tripped: string | undefined;
  let blockedBy: string | undefined; // why the first call of this question was refused, if one was

  return {
    startRun(): void {
      calls = 0;
      totalChars = 0;
      tripped = undefined;
      blockedBy = undefined;
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

    onToolStart(name: string, args: unknown): void {
      calls++;
      opts.onEvent?.({ kind: "call", n: calls, max: opts.maxCallsPerRun, tool: name });
      if (calls > opts.maxCallsPerRun && !tripped) {
        tripped = `tool-call limit reached (${opts.maxCallsPerRun} per question)`;
        opts.log(`stopping this question: ${tripped}; the call to ${safeForLog(name, 60)} is not run`);
        opts.onEvent?.({ kind: "tripped", reason: tripped });
      }
    },

    async beforeToolCall(ctx: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> {
      let reason = tripped;
      if (!reason && totalChars >= opts.maxTotalChars && !opts.budgetExempt?.includes(ctx.toolCall.name)) {
        reason = `tool output limit reached (${opts.maxTotalChars} characters per question)`;
      }
      if (!reason) return undefined;
      blockedBy ??= reason;
      opts.log(`blocked ${safeForLog(ctx.toolCall.name, 60)}: ${reason}`);
      opts.onEvent?.({ kind: "blocked", tool: ctx.toolCall.name, reason });
      return { block: true, reason, terminate: true };
    },

    async afterToolCall(ctx: AfterToolCallContext): Promise<AfterToolCallResult | undefined> {
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
      return truncated ? { content } : undefined;
    },
  };
}

// What happens after the model's reply to a question, when that reply is unusable: at most ONE retry per question,
// for any model. Two symptoms are handled:
//  - a runaway reply was cut off while streaming (src/runaway.ts);
//  - the reply finished with no answer text and no tool call (src/repair.ts).
// The retry runs with thinking off where the provider has a switch for it, to the end of the question.
// Kept apart from the CLI so the whole flow can be tested with a scripted model.
import type { Agent } from "@earendil-works/pi-agent-core";
import { answerlessReply, lastReasoning, retryWithoutThinking } from "./repair.ts";

export interface RecoverHooks {
  /** The reason the runaway guard fired since the last call (and clears it), or undefined. */
  takeRunaway(): string | undefined;
  /** True when nothing more may be asked of the model: user abort, guard trip, audit failure. */
  halted(): boolean;
  setNoThink(on: boolean): void;
  /** Whether the provider has a thinking-off switch (only changes the wording and the audit record). */
  canSwitchThinkingOff: boolean;
  record(type: string, data: Record<string, unknown>): void;
  /** A status line for the user. */
  say(line: string): void;
  /** Model-written text shown as a last resort (the caller cleans it for the terminal). */
  showReasoning(text: string): void;
}

/** Runs the recovery flow after `agent.prompt()`. Returns the reason when the question ended in a loop. */
export async function recoverReply(agent: Agent, h: RecoverHooks): Promise<{ stuck?: string }> {
  const mode = h.canSwitchThinkingOff ? "thinking off" : "plain retry";
  const how = h.canSwitchThinkingOff ? "asking again without thinking" : "asking again";
  let retried = false;

  const loop = h.takeRunaway();
  if (loop && !h.halted()) {
    retried = true;
    h.record("runaway_retry", { reason: loop, mode });
    h.say(`[repair] the model got stuck in a loop; ${how}`);
    await retryWithoutThinking(agent, h.setNoThink);
  } else if (!h.halted()) {
    const first = answerlessReply(agent.state.messages);
    if (first) {
      retried = true;
      const reasoningSeen = lastReasoning(agent.state.messages); // kept: the retry may come back with nothing at all
      h.record("repair", { kind: first, reason: first === "reasoning_only" ? "reply had reasoning but no answer text" : "reply was empty", action: `discard it and retry once (${mode})` });
      h.say(`[repair] the model ${first === "reasoning_only" ? "gave reasoning but no answer" : "returned an empty reply"}; ${how}`);
      await retryWithoutThinking(agent, h.setNoThink);
      return finish(reasoningSeen);
    }
  }
  return retried ? finish("") : {};

  // After the one retry: a loop ends the question; a reply that still has no answer is shown as it is.
  function finish(reasoningSeen: string): { stuck?: string } {
    const again = h.takeRunaway();
    if (h.halted()) return {};
    if (again) {
      h.record("runaway_failed", { reason: again });
      return { stuck: again };
    }
    const still = answerlessReply(agent.state.messages);
    if (still) {
      h.record("repair_failed", { kind: still });
      const shown = lastReasoning(agent.state.messages) || reasoningSeen;
      if (shown) {
        h.say("[the model gave no answer text; showing its reasoning as is]");
        h.showReasoning(shown);
      } else h.say("[the model returned no answer; ask again, or rephrase the question]");
    }
    return {};
  }
}

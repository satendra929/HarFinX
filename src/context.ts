// Conversation memory: what the model is shown of the earlier conversation. A view only: the full history in
// agent.state.messages and the audit log are never changed. Deterministic, no model involved.
//
// Per call (Pi's transformContext), the messages are cut into question groups (a user message and everything up to the
// next one). The current group is never touched. Finished groups are kept
//   - whole, with large tool results shortened to a one-line note (the last few), or
//   - as question and final answer only (older ones), or
//   - not at all (when the history budget is used up; one line says so).
// Pure functions plus a small stateful wrapper (makeContextView). Numbers come from src/contextSettings.ts.
import { carriedHeader } from "./documents/pages.ts";
import { oneLine } from "./feedback.ts";
import { DEFAULT_LIMITS } from "./guard.ts";
import type { ContextKnobs, ResolvedContext } from "./contextSettings.ts";

type Block = { type?: string; text?: unknown; [k: string]: unknown };
export type Msg = { role?: string; content?: unknown; [k: string]: unknown };

const MESSAGE_OVERHEAD = 12; // characters of framing per message
const NEXT_RESULT_RESERVE_CHARS = DEFAULT_LIMITS.maxOutputChars; // the guard's per-result cap: the current question may still read one more
const MARKER_RESERVE_CHARS = 300; // room kept for the "questions not shown" line
// The system message (prompt and tool list) is prose and JSON: measured about 4.6 characters per token, against about 2.4 for numeric page text.
const SYSTEM_CHARS_PER_TOKEN = 4;
const MAX_LISTED = 50; // ids and indices kept in a report

export interface ContextReport {
  /** The view differs from the input. */
  changed: boolean;
  level: string;
  window: number;
  /** Estimated tokens of the input and of the view, and their message counts. */
  tokensBefore: number;
  tokensAfter: number;
  messagesIn: number;
  messagesOut: number;
  /** Tokens the earlier conversation may use, after the cap by the room really left. */
  budget: number;
  /** Estimated tokens of the earlier conversation in the view. */
  history: number;
  fixed: number;
  current: number;
  /** Finished questions: kept whole, kept as question and answer, not shown (of which unanswered). */
  whole: number;
  shortened: number;
  omitted: number;
  unanswered: number;
  /** Tool results replaced by a note (ids, at most 50) and how many. */
  stubbedIds: string[];
  stubbed: number;
  /** Index in the input of the user messages of the shortened and the omitted questions (at most 50 each). */
  shortenedAt: number[];
  omittedAt: number[];
  /** The exact line placed in front of the first question shown, when questions were left out. */
  marker?: string;
  /** Short digest of the view, to compare with a rebuilt one. */
  digest?: string;
  error?: string;
}

const blocksOf = (m: Msg): Block[] => (Array.isArray(m.content) ? (m.content as Block[]).filter((b) => b && typeof b === "object") : []);
const textOf = (m: Msg): string => (typeof m.content === "string" ? m.content : blocksOf(m).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n"));
const callsOf = (m: Msg): Block[] => (m.role === "assistant" ? blocksOf(m).filter((b) => b.type === "toolCall") : []);

function charsOf(m: Msg): number {
  if (m.role === "system") return JSON.stringify(m).length; // the prompt, its sections and the tool list
  if (typeof m.content === "string") return MESSAGE_OVERHEAD + m.content.length;
  let n = MESSAGE_OVERHEAD;
  for (const b of blocksOf(m)) {
    if (b.type === "text" && typeof b.text === "string") n += b.text.length;
    else if (b.type === "toolCall") n += String(b.name ?? "").length + JSON.stringify(b.arguments ?? {}).length;
  }
  return n;
}
/** Estimated tokens of some messages: the system message at its own rate, everything else at `charsPerToken`. */
function estimate(ms: readonly Msg[], charsPerToken: number): number {
  return Math.ceil(ms.reduce((n, m) => n + charsOf(m) / (m.role === "system" ? SYSTEM_CHARS_PER_TOKEN : charsPerToken), 0));
}

/** Harness-written text built from model arguments and file text: one line, no brackets that could close the note. */
const clean = (v: unknown, max: number) => oneLine(v, max).replace(/\[/g, "(").replace(/\]/g, ")");
const whole = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(Math.trunc(v)) : "?");

interface Group {
  /** Index of the user message in the input. */
  at: number;
  msgs: Msg[];
}

/** The messages before the first user message (the system message), and the question groups. */
function split(messages: readonly Msg[]): { leading: Msg[]; groups: Group[] } {
  const first = messages.findIndex((m) => m?.role === "user");
  if (first < 0) return { leading: [...messages], groups: [] };
  const groups: Group[] = [];
  for (let i = first; i < messages.length; i++) {
    // a message the harness sent inside the question (the figure repair, tagged) belongs to the question: it never starts one
    if (messages[i]?.role === "user" && (messages[i] as { harness?: string }).harness !== "repair") groups.push({ at: i, msgs: [messages[i]] });
    else groups[groups.length - 1].msgs.push(messages[i]);
  }
  return { leading: messages.slice(0, first), groups };
}

/** The final answer of a group: its last message, an assistant reply that stopped on its own ("stop" or "length"), has text and no tool call. */
function finalAnswer(g: Group): Msg | undefined {
  const last = g.msgs[g.msgs.length - 1];
  if (!last || last.role !== "assistant" || callsOf(last).length > 0) return undefined;
  if (last.stopReason !== "stop" && last.stopReason !== "length") return undefined;
  return textOf(last).trim() ? last : undefined;
}

/** The message without its thinking blocks; undefined when nothing else is left in it. */
function withoutThinking(m: Msg): Msg | undefined {
  if (!Array.isArray(m.content) || !blocksOf(m).some((b) => b.type === "thinking")) return m;
  const kept = (m.content as Block[]).filter((b) => b?.type !== "thinking");
  return kept.length ? { ...m, content: kept } : undefined;
}

function argSummary(call: Block | undefined): string {
  const args = call?.arguments;
  if (!args || typeof args !== "object") return "";
  return Object.entries(args as Record<string, unknown>)
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .slice(0, 3)
    .map(([k, v]) => `${clean(k, 20)}=${clean(v, 60)}`)
    .join(", ");
}

/** The one-line note that replaces a tool result, or undefined when the result stays. */
function stubFor(m: Msg, call: Block | undefined, knobs: ContextKnobs, keepResults: boolean): string | undefined {
  if (m.isError === true || m.toolName === "calculate" || (keepResults && m.toolName === "read_page")) return undefined;
  const text = textOf(m);
  // A skill is a procedure for one question: in a finished question it is always shortened, at every size (a lenient level would keep it whole
  // and it could steer an unrelated later question); the model reads it again when the next task needs it.
  if (m.toolName !== "read_skill" && text.length <= knobs.stubOver) return undefined;
  const tool = clean(m.toolName, 30);
  if (m.toolName === "read_page") {
    const d = (m.details && typeof m.details === "object" ? m.details : {}) as Record<string, unknown>;
    const args = (call?.arguments && typeof call.arguments === "object" ? call.arguments : {}) as Record<string, unknown>;
    const file = d.path ?? args.path;
    const page = d.page ?? args.page;
    const part = d.part ?? args.part;
    const header = carriedHeader(text.split("\n")).map((l) => clean(l, 100));
    return (
      `[earlier result omitted to save space: read_page ${clean(file, 80)} page ${whole(page)}${typeof part === "number" && part > 1 ? ` part ${whole(part)}` : ""}.` +
      (header.length ? ` Header: ${header.join("; ")}.` : "") +
      " Figures from it are not shown: read the page again before stating any.]"
    );
  }
  const args = argSummary(call);
  return `[earlier result omitted to save space: ${tool}${args ? " " + args : ""}. Run it again if you need it.]`;
}

/** A finished group kept whole: no thinking, large tool results replaced by a note. */
function wholeForm(g: Group, knobs: ContextKnobs, keepResults: boolean, stubbedIds: string[]): Msg[] {
  const calls = new Map<string, Block>();
  for (const m of g.msgs) for (const c of callsOf(m)) if (typeof c.id === "string") calls.set(c.id, c);
  const out: Msg[] = [];
  for (const m of g.msgs) {
    if (m.role === "assistant") {
      const kept = withoutThinking(m);
      if (kept) out.push(kept);
    } else if (m.role === "toolResult") {
      if (typeof m.toolCallId !== "string" || !calls.has(m.toolCallId)) continue; // a result whose call is not in this group would be an orphan
      const stub = stubFor(m, calls.get(m.toolCallId), knobs, keepResults);
      if (stub !== undefined) {
        stubbedIds.push(m.toolCallId);
        out.push({ ...m, content: [{ type: "text", text: stub }] });
      } else out.push(m);
    } else out.push(m);
  }
  return out;
}

/** A finished group kept as the question and the final answer text only. */
function shortForm(g: Group, answer: Msg): Msg[] {
  return [g.msgs[0], { ...answer, content: blocksOf(answer).filter((b) => b.type === "text" && typeof b.text === "string" && (b.text as string).trim()) }];
}

function filesOf(g: Group): string[] {
  const out: string[] = [];
  for (const m of g.msgs) {
    const d = m.role === "toolResult" && m.details && typeof m.details === "object" ? (m.details as Record<string, unknown>).path : undefined;
    if (typeof d === "string") out.push(d);
    for (const c of callsOf(m)) {
      const p = (c.arguments as Record<string, unknown> | undefined)?.path;
      if (typeof p === "string") out.push(p);
    }
  }
  return out;
}

function withMarker(m: Msg, marker: string): Msg {
  if (typeof m.content === "string") return { ...m, content: `${marker}\n\n${m.content}` };
  return { ...m, content: [{ type: "text", text: marker }, ...(Array.isArray(m.content) ? m.content : [])] };
}

function digest(messages: readonly Msg[]): string {
  let h = 5381;
  for (const m of messages) {
    const s = `${m.role}:${textOf(m)}:${callsOf(m).map((c) => String(c.id)).join(",")}`;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Tokens the earlier conversation may use right now: its share of the window, capped by the room really left. */
export function historyBudget(window: number, knobs: ContextKnobs, fixedTokens: number, currentTokens: number): number {
  return Math.max(0, Math.min(Math.floor(knobs.historyShare * window), window - knobs.replyReserve - fixedTokens - currentTokens));
}

interface Candidate {
  form: "whole" | "short";
  msgs: Msg[];
  stubbed: string[];
}

function markerLine(n: number, files: string[]): string {
  const names = [...new Set(files.map((f) => clean(f, 60)).filter(Boolean))].slice(0, 3);
  return (
    `[Earlier in this conversation, ${n} question${n === 1 ? " is" : "s are"} not shown` +
    (names.length ? ` (${n === 1 ? "it" : "they"} used ${names.join(", ")})` : "") +
    `. Re-ask, or read the pages again, if you need ${n === 1 ? "it" : "them"}.]`
  );
}

/**
 * The view of `messages` for one model call. Returns the input array itself when nothing needs to change. `knobs` are the
 * resolved numbers; `window` is the model's context window in tokens. Never mutates the input.
 */
export function compactContext(messages: readonly Msg[], opts: { window: number; knobs: ContextKnobs; level?: string }): { messages: Msg[]; report: ContextReport } {
  const { knobs } = opts;
  const tokens = (chars: number) => Math.ceil(chars / knobs.charsPerToken);
  const est = (ms: readonly Msg[]) => estimate(ms, knobs.charsPerToken);
  const { leading, groups } = split(messages);
  const before = est(messages);
  const fresh = (): ContextReport => ({
    changed: false, level: opts.level ?? "", window: opts.window, tokensBefore: before, tokensAfter: before, messagesIn: messages.length, messagesOut: messages.length, budget: 0, history: 0, fixed: est(leading), current: 0,
    whole: 0, shortened: 0, omitted: 0, unanswered: 0, stubbedIds: [], stubbed: 0, shortenedAt: [], omittedAt: [],
  });
  const report = fresh();
  if (!(opts.window > 0) || groups.length < 2) return { messages: messages as Msg[], report };

  const current = groups[groups.length - 1];
  const done = groups.slice(0, -1);
  report.current = est(current.msgs) + tokens(NEXT_RESULT_RESERVE_CHARS);
  report.budget = historyBudget(opts.window, knobs, report.fixed, report.current);
  const limit = Math.max(0, report.budget - tokens(MARKER_RESERVE_CHARS)); // the "not shown" line has to fit as well

  // Newest finished question first: whole (the recent ones), then question and answer, then not at all. Once one does not
  // fit, every older one is left out too. A question without a final answer is never kept, and does not count when
  // deciding which questions are "recent".
  const kept = new Map<number, Msg[]>();
  const keptStubbed = new Map<number, string[]>();
  const omitted: Group[] = [];
  let used = 0;
  let stopped = false;
  let rank = 0; // 0 = the most recent finished question that has an answer
  for (let k = done.length - 1; k >= 0; k--) {
    const g = done[k];
    const answer = finalAnswer(g);
    if (!answer) {
      report.unanswered++;
      omitted.push(g);
      continue;
    }
    const myRank = rank++;
    if (stopped) {
      omitted.push(g);
      continue;
    }
    const candidates: Candidate[] = [];
    if (myRank < knobs.recentGroups) {
      if (myRank === 0 && knobs.keepPrevPages) {
        const stubbed: string[] = [];
        candidates.push({ form: "whole", msgs: wholeForm(g, knobs, true, stubbed), stubbed });
      }
      const stubbed: string[] = [];
      candidates.push({ form: "whole", msgs: wholeForm(g, knobs, false, stubbed), stubbed });
    }
    if (knobs.olderForm === "qa") candidates.push({ form: "short", msgs: shortForm(g, answer), stubbed: [] });
    const fit = candidates.find((c) => used + est(c.msgs) <= limit);
    if (!fit) {
      stopped = true;
      omitted.push(g);
      continue;
    }
    used += est(fit.msgs);
    kept.set(g.at, fit.msgs);
    keptStubbed.set(g.at, fit.stubbed);
    report.stubbed += fit.stubbed.length;
    if (fit.form === "whole") report.whole++;
    else {
      report.shortened++;
      report.shortenedAt.push(g.at);
    }
  }

  // Assemble in the original order; the omitted questions leave one line in front of the first question shown.
  const view: Msg[] = [...leading];
  for (const g of done) {
    const msgs = kept.get(g.at);
    if (msgs) view.push(...msgs);
    report.stubbedIds.push(...(keptStubbed.get(g.at) ?? []));
  }
  view.push(...current.msgs);
  if (omitted.length > 0) {
    omitted.sort((a, b) => a.at - b.at); // oldest first
    const marker = markerLine(omitted.length, omitted.flatMap(filesOf));
    const at = view.findIndex((m, i) => i >= leading.length && m.role === "user");
    view[at] = withMarker(view[at], marker); // when every earlier question is gone this is the current question: a copy, never the stored message
    report.marker = marker;
    report.omitted = omitted.length;
    report.omittedAt = omitted.map((g) => g.at).slice(0, MAX_LISTED);
  }
  report.shortenedAt = report.shortenedAt.sort((a, b) => a - b).slice(0, MAX_LISTED);
  report.stubbedIds = report.stubbedIds.slice(0, MAX_LISTED);
  report.history = used;
  report.tokensAfter = est(view);
  report.messagesOut = view.length;
  // a view that is not smaller than the input is no use: send the input, and report it as unchanged
  if (report.tokensAfter >= before) return { messages: messages as Msg[], report: fresh() };
  report.changed = true;
  report.digest = digest(view);
  return { messages: view, report };
}

/** The dim line under an answer when the view was trimmed. */
export function trimLine(r: ContextReport): string {
  const parts = [
    r.shortened > 0 ? `${r.shortened} earlier question${r.shortened === 1 ? "" : "s"} shortened` : "",
    r.omitted > 0 ? `${r.omitted} not shown` : "",
    r.stubbed > 0 ? `${r.stubbed} earlier result${r.stubbed === 1 ? "" : "s"} shortened` : "",
  ].filter(Boolean);
  return `context trimmed in the model's view: ${parts.join(", ")} (/context for details)`;
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** The lines `/context` prints. Only numbers and fixed words, nothing the model or a file wrote. */
export function describeContext(resolved: ResolvedContext, window: number, report: ContextReport | undefined, how: "auto" | "setting" | "command", promptTokens?: number): string[] {
  const out: string[] = [];
  const source = resolved.mode === "auto" ? (how === "command" ? "auto, from the window; set with /context" : "auto, from the window") : how === "command" ? "set with /context" : "set in the settings";
  if (resolved.level === "off") {
    out.push(`context memory: off (${source}); the full conversation is sent every time`);
  } else {
    const k = resolved.knobs;
    out.push(`context memory: ${resolved.level} (${source}), window ${fmt(window)} tokens`);
    out.push(
      `  history up to ${Math.round(k.historyShare * 100)}% of the window; ${k.recentGroups} recent question${k.recentGroups === 1 ? "" : "s"} whole; previous question's pages ${k.keepPrevPages ? "kept when they fit" : "shortened"}; ` +
        `results over ${fmt(k.stubOver)} characters shortened; ${fmt(k.replyReserve)} tokens kept for the reply; ${k.charsPerToken} characters per token; older questions: ${k.olderForm === "qa" ? "question and answer" : "dropped"}`,
    );
    if (resolved.overridden.length) out.push(`  set on their own: ${resolved.overridden.join(", ")}`);
  }
  if (promptTokens && window > 0) out.push(`  last prompt: ${fmt(promptTokens)} of ${fmt(window)} tokens (${Math.round((100 * promptTokens) / window)}%)`);
  if (resolved.level !== "off") {
    if (!report) out.push("  nothing to report yet");
    else if (!report.changed) out.push(`  last view: unchanged, about ${fmt(report.tokensBefore)} tokens`);
    else {
      out.push(`  last view: about ${fmt(report.tokensBefore)} tokens cut to ${fmt(report.tokensAfter)}; earlier conversation ${fmt(report.history)} of ${fmt(report.budget)} tokens allowed`);
      out.push(`  ${report.whole} question${report.whole === 1 ? "" : "s"} whole, ${report.shortened} as question and answer, ${report.omitted} not shown (${report.unanswered} unanswered); ${report.stubbed} result${report.stubbed === 1 ? "" : "s"} shortened`);
    }
  }
  return out;
}

export interface ContextView {
  /** Pi's transformContext: the view for one call. Never throws; on any failure the messages go through unchanged. */
  transform: (messages: any[], signal?: AbortSignal) => Promise<any[]>;
  /** Call at the start of each question. */
  beginQuestion(): void;
  /** Call on /new. */
  reset(): void;
  /** The report of the latest call, if any. */
  last(): ContextReport | undefined;
  /** The latest report of this question that changed the view. */
  trimmed(): ContextReport | undefined;
}

/**
 * The stateful wrapper. `settings` is read on every call (so /model, the mismatch check and /context take effect at
 * once). `onReport` hears about a trim once per question, and again only if the trim changes within the question; a
 * failure is reported once per question.
 */
export function makeContextView(opts: { window: () => number; settings: (window: number) => ResolvedContext; onReport?: (r: ContextReport) => void }): ContextView {
  let last: ContextReport | undefined;
  let trimmed: ContextReport | undefined;
  let signature: string | undefined;
  let failed = false;
  const hear = (r: ContextReport) => {
    try {
      opts.onReport?.(r);
    } catch {
      /* a listener must not break a model call */
    }
  };
  return {
    async transform(messages) {
      try {
        const window = opts.window();
        const resolved = opts.settings(window);
        if (resolved.level === "off") {
          last = undefined;
          return messages;
        }
        const { messages: view, report } = compactContext(messages, { window, knobs: resolved.knobs, level: resolved.level });
        last = report;
        if (report.changed) {
          trimmed = report;
          const sig = `${report.whole}/${report.shortened}/${report.omitted}/${report.stubbed}`;
          if (sig !== signature) {
            signature = sig;
            hear(report);
          }
        }
        return view;
      } catch (err) {
        if (!failed) {
          failed = true;
          hear({ changed: false, level: "", window: 0, tokensBefore: 0, tokensAfter: 0, messagesIn: 0, messagesOut: 0, budget: 0, history: 0, fixed: 0, current: 0, whole: 0, shortened: 0, omitted: 0, unanswered: 0, stubbedIds: [], stubbed: 0, shortenedAt: [], omittedAt: [], error: err instanceof Error ? err.message : String(err) });
        }
        return messages;
      }
    },
    beginQuestion() {
      trimmed = undefined;
      signature = undefined;
      failed = false;
    },
    reset() {
      last = undefined;
      trimmed = undefined;
      signature = undefined;
      failed = false;
    },
    last: () => last,
    trimmed: () => trimmed,
  };
}

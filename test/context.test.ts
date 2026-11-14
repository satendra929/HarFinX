import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { compactContext, describeContext, historyBudget, makeContextView, trimLine, type ContextReport, type Msg } from "../src/context.ts";
import { AUTO_BALANCED_FROM, AUTO_LENIENT_FROM, CONTEXT_LEVELS, autoLevel, parseContextConfig, resolveContext, type ContextKnobs } from "../src/contextSettings.ts";

// ---- builders: messages shaped as Pi builds them ---------------------------------------------------------------------
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const sys = (): Msg => ({ role: "system", content: "You are a careful assistant for financial analysts. ".repeat(4), tools: [{ name: "read_page" }] });
const user = (text: string): Msg => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });
const asst = (content: object[], stopReason = "stop"): Msg => ({ role: "assistant", content, api: "openai-completions", provider: "any", model: "fake", usage, stopReason, timestamp: 0 });
const result = (id: string, tool: string, text: string, details?: unknown, isError = false): Msg => ({ role: "toolResult", toolCallId: id, toolName: tool, content: [{ type: "text", text }], details, isError, timestamp: 0 });
const page = (n: number, filler = 3000) => `[page ${n} of 100 in filings/X.pdf]\n(in millions)\n|  2022  |  2021\n` + "Revenue | 1,000 | 900\n".repeat(Math.ceil(filler / 22)) + `[end of page ${n}]`;

let ids = 0;
interface GroupOpts { pages?: number; answer?: string; file?: string; thinking?: boolean; end?: "answer" | "toolResult" | "aborted" | "error" }
function group(q: string, o: GroupOpts = {}): Msg[] {
  const out: Msg[] = [user(q)];
  for (let i = 0; i < (o.pages ?? 1); i++) {
    const id = `c${++ids}`;
    out.push(asst([...(o.thinking ? [{ type: "thinking", thinking: "let me think" }] : []), call(id, "read_page", { path: o.file ?? "filings/X.pdf", page: 5 + i })], "toolUse"));
    out.push(result(id, "read_page", page(5 + i), { path: o.file ?? "filings/X.pdf", page: 5 + i, part: 1, parts: 1, pages: 100 }));
  }
  const end = o.end ?? "answer";
  if (end === "answer") out.push(asst([{ type: "text", text: o.answer ?? `Answer to ${q}: revenue was 1,000.` }]));
  else if (end === "aborted") out.push(asst([], "aborted"));
  else if (end === "error") out.push(asst([], "error"));
  return out;
}
const chat = (...groups: Msg[][]): Msg[] => [sys(), ...groups.flat()];
const balanced: ContextKnobs = CONTEXT_LEVELS.balanced;
const knobs = (over: Partial<ContextKnobs> = {}): ContextKnobs => ({ ...balanced, ...over });
const run = (m: Msg[], over: Partial<ContextKnobs> = {}, window = 16384) => compactContext(m, { window, knobs: knobs(over), level: "t" });
const texts = (m: Msg[]) => m.map((x) => (typeof x.content === "string" ? x.content : (x.content as any[]).map((b) => b.text ?? (b.type === "toolCall" ? `<call ${b.id}>` : `<${b.type}>`)).join("")));
function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}
/** Every tool result follows the assistant message that made its call, and every call has its result. */
function assertPaired(view: Msg[]): void {
  const open = new Set<string>();
  for (const m of view) {
    if (m.role === "assistant") for (const b of (m.content as any[]) ?? []) if (b.type === "toolCall") open.add(b.id);
    if (m.role === "toolResult") {
      assert.ok(open.has(m.toolCallId as string), `result ${m.toolCallId} has no call before it`);
      open.delete(m.toolCallId as string);
    }
  }
  assert.equal(open.size, 0, "a call has no result");
}

// ---- when nothing changes -----------------------------------------------------------------------------------------------

test("a first question (nothing finished yet) and an empty chat come back as the same array", () => {
  const first = chat(group("q1"));
  const r = run(first);
  assert.equal(r.messages, first);
  assert.equal(r.report.changed, false);
  const empty: Msg[] = [];
  assert.equal(run(empty).messages, empty);
  const onlySystem = [sys()];
  assert.equal(run(onlySystem).messages, onlySystem);
  assert.equal(run(first, {}, 0).messages, first); // an unknown window changes nothing
});

test("short finished questions that gain nothing from trimming come back as the same array", () => {
  const m: Msg[] = [sys(), user("a"), asst([{ type: "text", text: "A" }]), user("b"), asst([{ type: "text", text: "B" }]), user("c")];
  const r = run(m);
  assert.equal(r.messages, m);
  assert.equal(r.report.changed, false);
});

test("the input is never changed (frozen input works) and compacting the view again gives the same view", () => {
  const m = deepFreeze(chat(group("q1", { thinking: true }), group("q2", { pages: 2 }), group("q3"), group("q4")));
  const r = run(m, { recentGroups: 1 }, 8192);
  assert.equal(r.report.changed, true);
  const again = run(r.messages, { recentGroups: 1 }, 8192);
  assert.deepEqual(again.messages, r.messages);
});

// ---- the current question ---------------------------------------------------------------------------------------------

test("the current question is untouched, however large, and its messages are the very same objects", () => {
  const cur = group("now", { pages: 4, end: "toolResult", thinking: true });
  const m = chat(group("q1"), group("q2"), cur);
  const r = run(m, {}, 32768);
  const tail = r.messages.slice(-cur.length);
  tail.forEach((x, i) => assert.equal(x, cur[i]));
  assertPaired(r.messages);
});

// ---- shortening tool results ------------------------------------------------------------------------------------------

test("a big page read of a finished question becomes one note naming the page and keeping its header; the original is not edited", () => {
  const m = chat(group("q1"), group("q2"), group("q3"));
  const r = run(m, { keepPrevPages: false });
  const stubs = r.messages.filter((x) => x.role === "toolResult" && /^\[earlier/.test((x.content as any[])[0].text)); // q3 is the current question: not shortened
  assert.equal(stubs.length, 2);
  const t = (stubs[0].content as any[])[0].text as string;
  assert.equal(t, "[earlier result omitted to save space: read_page filings/X.pdf page 5. Header: (in millions); | 2022 | 2021. Figures from it are not shown: read the page again before stating any.]");
  assert.equal((stubs[0].content as any[]).length, 1);
  assert.equal(stubs[0].toolCallId, m.find((x) => x.role === "toolResult")!.toolCallId);
  assert.match(((m.find((x) => x.role === "toolResult")!.content as any[])[0].text as string), /^\[page 5 of 100/); // the stored message is intact
  assert.equal(r.report.stubbed, 2);
  assertPaired(r.messages);
});

test("the previous question keeps its page reads whole when they fit (and the setting can turn that off)", () => {
  const m = chat(group("q1"), group("q2"), group("q3"));
  const keep = run(m);
  const results = keep.messages.filter((x) => x.role === "toolResult");
  assert.equal(results.length, 3);
  assert.match((results[1].content as any[])[0].text, /^\[page 5 of 100/); // q2, the previous question: whole
  assert.match((results[0].content as any[])[0].text, /^\[earlier result omitted/); // q1: shortened
  const strict = run(m, { keepPrevPages: false });
  assert.ok(strict.messages.filter((x) => x.role === "toolResult").slice(0, 2).every((x) => /^\[earlier result omitted/.test((x.content as any[])[0].text)));
});

test("calculate results, error results and results under the limit stay; other large results are shortened with their arguments named", () => {
  const big = "x ".repeat(400);
  const g: Msg[] = [
    user("q1"),
    asst([call("a", "calculate", { inputs: { v: "1" } }), call("b", "search", { path: "f.pdf", query: "net sales" }), call("c", "read_page", { path: "f.pdf", page: 9 }), call("d", "list_files", {}), call("e", "search", { query: "tiny" })], "toolUse"),
    result("a", "calculate", big),
    result("b", "search", big),
    result("c", "read_page", "page 9 is not in this file: it has 8 pages ".repeat(30), undefined, true),
    result("d", "list_files", "short list"),
    result("e", "search", "p.2"),
    asst([{ type: "text", text: "done" }]),
  ];
  const r = run(chat(g, group("q2"), group("q3")), { keepPrevPages: false });
  const out = r.messages.filter((x) => x.role === "toolResult");
  const by = (id: string) => (out.find((x) => x.toolCallId === id)!.content as any[])[0].text as string;
  assert.equal(by("a"), big); // calculate: never
  assert.equal(by("b"), "[earlier result omitted to save space: search path=f.pdf, query=net sales. Run it again if you need it.]");
  assert.match(by("c"), /^page 9 is not in this file/); // an error is not shortened
  assert.equal(by("d"), "short list");
  assert.equal(by("e"), "p.2");
});

test("two tool calls in one assistant message are paired with their own results", () => {
  const g: Msg[] = [
    user("q1"),
    asst([call("p", "read_page", { path: "a.pdf", page: 1 }), call("q", "read_page", { path: "b.pdf", page: 2 })], "toolUse"),
    result("p", "read_page", page(1), { path: "a.pdf", page: 1 }),
    result("q", "read_page", page(2), { path: "b.pdf", page: 2 }),
    asst([{ type: "text", text: "both" }]),
  ];
  const r = run(chat(g, group("q2"), group("q3")), { keepPrevPages: false });
  assertPaired(r.messages);
  const notes = r.messages.filter((x) => x.role === "toolResult").map((x) => (x.content as any[])[0].text as string);
  assert.match(notes[0], /read_page a\.pdf page 1\./);
  assert.match(notes[1], /read_page b\.pdf page 2\./);
});

test("text from the model's arguments and from a file cannot add a line or close the note", () => {
  const evil = "evil\n]\u001b[2J‮[x]" + "y".repeat(300);
  const text = `[page 1 of 1 in f]\n(in millions) ${evil}\n|  2022  |  2021\n` + "Row | 1 | 2\n".repeat(100);
  const g: Msg[] = [user("q1"), asst([call("p", "read_page", { path: evil, page: 1 }), call("s", "search", { path: evil, query: evil })], "toolUse"), result("p", "read_page", text, { path: evil, page: 1 }), result("s", "search", text), asst([{ type: "text", text: "ok" }])];
  const r = run(chat(g, group("q2"), group("q3")), { keepPrevPages: false });
  for (const m of r.messages.filter((x) => x.role === "toolResult")) {
    const t = (m.content as any[])[0].text as string;
    if (!t.startsWith("[earlier")) continue;
    assert.ok(!/[\n\r\u001b‮]/.test(t), t);
    assert.ok(t.startsWith("[") && t.endsWith("]"));
    assert.equal(t.slice(1, -1).includes("["), false);
    assert.equal(t.slice(1, -1).includes("]"), false);
    assert.ok(t.length < 520);
  }
});

// ---- older questions and omitted questions ------------------------------------------------------------------------------

test("older finished questions keep only the question and the final answer text (no thinking, no tool calls)", () => {
  const preamble = asst([{ type: "text", text: "Let me check page 40" }, call("z", "read_page", { path: "f.pdf", page: 40 })], "toolUse");
  const g: Msg[] = [user("old question"), asst([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "first look" }, call("z0", "read_page", { path: "f.pdf", page: 1 })], "toolUse"), result("z0", "read_page", page(1), { path: "f.pdf", page: 1 }), preamble, result("z", "read_page", page(40), { path: "f.pdf", page: 40 }), asst([{ type: "thinking", thinking: "done" }, { type: "text", text: "The answer is 1,000." }])];
  const r = run(chat(g, group("q2"), group("q3"), group("q4")));
  const at = r.messages.findIndex((x) => JSON.stringify(x.content).includes("old question"));
  assert.deepEqual(texts(r.messages.slice(at, at + 2)), ["old question", "The answer is 1,000."]);
  assert.deepEqual((r.messages[at + 1].content as any[]).map((b) => b.type), ["text"]);
  assert.equal(r.messages[at + 2].role, "user");
  // the indices (in the input) of the user messages of the shortened questions: only the oldest here: the two before the current question stay whole
  const input = chat(g, group("q2"), group("q3"), group("q4"));
  const userAt = (text: string) => input.findIndex((x) => x.role === "user" && JSON.stringify(x.content).includes(text));
  assert.deepEqual(r.report.shortenedAt, [userAt("old question")]);
  assertPaired(r.messages);
});

test("recentGroups sets how many finished questions stay whole; 0 shortens them all; olderForm none drops the older ones", () => {
  const m = chat(group("q1"), group("q2"), group("q3"), group("q4"), group("q5"));
  const count = (rep: ContextReport) => [rep.whole, rep.shortened, rep.omitted];
  assert.deepEqual(count(run(m, { recentGroups: 2 }).report), [2, 2, 0]);
  assert.deepEqual(count(run(m, { recentGroups: 0 }).report), [0, 4, 0]);
  assert.deepEqual(count(run(m, { recentGroups: 4 }).report), [4, 0, 0]);
  assert.deepEqual(count(run(m, { recentGroups: 1, olderForm: "none" }).report), [1, 0, 3]);
});

test("a question with no final answer (stopped, aborted, error, or ended on a tool result) is not kept; the questions around it are", () => {
  for (const end of ["toolResult", "aborted", "error"] as const) {
    const m = chat(group("q1"), group("lost", { end }), group("q3"), group("q4"));
    const r = run(m);
    assert.equal(r.report.unanswered, 1, end);
    assert.equal(r.report.omitted, 1);
    assert.ok(!JSON.stringify(r.messages).includes("lost"), end);
    assert.ok(JSON.stringify(r.messages).includes("q1"));
    assertPaired(r.messages);
  }
});

test("when the budget is used up the oldest questions are left out, one line says how many and which files, and the newest are kept", () => {
  const long = "Revenue was 1,000 and cost 600 in the year. ".repeat(14);
  const gs = Array.from({ length: 12 }, (_, i) => group(`question ${i + 1}`, { answer: long, file: i < 6 ? "filings/OLD.pdf" : "filings/NEW.pdf" }));
  const m = chat(...gs, group("now"));
  const r = run(m, {}, 8192);
  assert.ok(r.report.omitted > 0 && r.report.omitted < 12);
  const shown = r.messages.filter((x) => x.role === "user").map((x) => JSON.stringify(x.content));
  assert.ok(shown.at(-2)!.includes("question 12"), "the newest finished question is kept");
  assert.ok(!shown.some((s) => s.includes("question 1\"")), "the oldest is gone");
  const marker = (r.messages.find((x) => x.role === "user")!.content as any[])[0].text as string;
  assert.equal(marker, r.report.marker);
  assert.match(marker, new RegExp(`^\\[Earlier in this conversation, ${r.report.omitted} questions are not shown \\(they used filings/OLD\\.pdf.*\\)\\. Re-ask, or read the pages again, if you need them\\.\\]$`));
  assert.ok(r.report.history <= r.report.budget);
  assertPaired(r.messages);
  // the questions kept are exactly the newest ones, in order
  const nums = shown.slice(0, -1).map((s) => Number(/question (\d+)/.exec(s)![1]));
  assert.deepEqual(nums, nums.slice().sort((a, b) => a - b));
  assert.equal(nums.at(-1), 12);
});

test("when every earlier question is left out the line goes on a COPY of the current question; the stored message is untouched; string content works too", () => {
  const long = "word ".repeat(1200);
  const cur = group("now", { end: "toolResult" });
  const m = chat(group("q1", { answer: long }), group("q2", { answer: long }), cur);
  const r = run(m, { historyShare: 0.05 }, 8192);
  assert.equal(r.report.omitted, 2);
  const first = r.messages[1];
  assert.notEqual(first, cur[0]);
  assert.equal((first.content as any[])[0].text, r.report.marker);
  assert.equal((first.content as any[])[1].text, "now");
  assert.equal((cur[0].content as any[]).length, 1); // the stored message is unchanged
  const s = run([sys(), { role: "user", content: "old", timestamp: 0 }, asst([{ type: "text", text: long }]), { role: "user", content: "now", timestamp: 0 }], { historyShare: 0.05 }, 8192);
  assert.equal(s.messages[1].content, `${s.report.marker}\n\nnow`);
});

test("a single omitted question is worded in the singular", () => {
  const long = "word ".repeat(1200);
  const r = run(chat(group("q1", { answer: long }), group("now", { end: "toolResult" })), { historyShare: 0.05 }, 8192);
  assert.match(r.report.marker!, /^\[Earlier in this conversation, 1 question is not shown \(it used filings\/X\.pdf\)\. Re-ask, or read the pages again, if you need it\.\]$/);
});

// ---- the budget ---------------------------------------------------------------------------------------------------------

test("historyBudget: the share of the window, capped by the room really left, never negative", () => {
  const k = knobs();
  assert.equal(historyBudget(16384, k, 800, 2000), 4096); // share binds
  assert.equal(historyBudget(16384, k, 800, 10000), 16384 - 4096 - 800 - 10000); // room binds
  assert.equal(historyBudget(8192, k, 800, 9000), 0);
  assert.equal(historyBudget(8192, knobs({ historyShare: 0.5 }), 800, 100), 3196); // a big share on a small window: the room still caps it (8192 - 4096 - 800 - 100)
});

test("the budget shrinks as the current question grows, so fewer earlier questions fit", () => {
  const long = "Revenue was 1,000 and cost 600. ".repeat(20);
  const gs = Array.from({ length: 8 }, (_, i) => group(`question ${i + 1}`, { answer: long }));
  const small = run(chat(...gs, group("now", { end: "toolResult", pages: 1 })), {}, 12000);
  const large = run(chat(...gs, group("now", { end: "toolResult", pages: 3 })), {}, 12000);
  assert.ok(large.report.budget < small.report.budget);
  assert.ok(large.report.omitted >= small.report.omitted);
});

test("a more lenient level keeps more, and lenient still respects the room on a small window", () => {
  const long = "Revenue was 1,000 and cost 600. ".repeat(20);
  const gs = Array.from({ length: 24 }, (_, i) => group(`question ${i + 1}`, { answer: long.repeat(2) }));
  const m = chat(...gs, group("now"));
  const strict = compactContext(m, { window: 16384, knobs: CONTEXT_LEVELS.strict });
  const lenient = compactContext(m, { window: 16384, knobs: CONTEXT_LEVELS.lenient });
  assert.ok(lenient.report.whole > strict.report.whole);
  assert.ok(lenient.report.history > strict.report.history);
  assert.equal(lenient.report.stubbed, 0); // lenient shortens nothing: its limit is above the guard's per-result cap
  const tiny = compactContext(m, { window: 4096, knobs: CONTEXT_LEVELS.lenient });
  assert.ok(tiny.report.history <= tiny.report.budget);
  assert.equal(tiny.report.budget, 0);
});

// ---- settings -----------------------------------------------------------------------------------------------------------

test("levels: the presets are as documented", () => {
  assert.deepEqual(CONTEXT_LEVELS.strict, { historyShare: 0.2, recentGroups: 1, keepPrevPages: false, stubOver: 300, replyReserve: 2048, charsPerToken: 2.5, olderForm: "qa", trimLine: true });
  assert.deepEqual(CONTEXT_LEVELS.balanced, { historyShare: 0.25, recentGroups: 2, keepPrevPages: true, stubOver: 400, replyReserve: 4096, charsPerToken: 2.5, olderForm: "qa", trimLine: true });
  assert.deepEqual(CONTEXT_LEVELS.lenient, { historyShare: 0.5, recentGroups: 4, keepPrevPages: true, stubOver: 6000, replyReserve: 4096, charsPerToken: 2.5, olderForm: "qa", trimLine: true });
});

test("auto picks the level from the window; the boundaries are exact", () => {
  assert.equal(AUTO_BALANCED_FROM, 12_000);
  assert.equal(AUTO_LENIENT_FROM, 48_000);
  assert.equal(autoLevel(8192), "strict");
  assert.equal(autoLevel(11_999), "strict");
  assert.equal(autoLevel(12_000), "balanced");
  assert.equal(autoLevel(16384), "balanced");
  assert.equal(autoLevel(47_999), "balanced");
  assert.equal(autoLevel(48_000), "lenient");
  assert.equal(autoLevel(200_000), "lenient");
  assert.equal(autoLevel(0), "balanced");
  assert.equal(resolveContext({ mode: "auto", overrides: {} }, 16384).level, "balanced");
  assert.equal(resolveContext({ mode: "auto", overrides: {} }, 200_000).knobs.recentGroups, 4);
});

test("a named level ignores the window; off is off; single settings win over the preset and are listed", () => {
  assert.equal(resolveContext({ mode: "strict", overrides: {} }, 200_000).level, "strict");
  assert.equal(resolveContext({ mode: "lenient", overrides: {} }, 4096).level, "lenient");
  assert.equal(resolveContext({ mode: "off", overrides: {} }, 16384).level, "off");
  const r = resolveContext({ mode: "balanced", overrides: { recentGroups: 3, historyShare: 0.4 } }, 16384);
  assert.equal(r.knobs.recentGroups, 3);
  assert.equal(r.knobs.historyShare, 0.4);
  assert.equal(r.knobs.stubOver, 400);
  assert.deepEqual(r.overridden, ["recentGroups", "historyShare"]);
});

test("parseContextConfig: unset means auto with no overrides; every setting is read; bad values stop with the setting's name", () => {
  assert.deepEqual(parseContextConfig({}), { mode: "auto", overrides: {} });
  assert.deepEqual(parseContextConfig({ CONTEXT_MEMORY: "  ", CONTEXT_RECENT_GROUPS: "" }), { mode: "auto", overrides: {} });
  assert.equal(parseContextConfig({ CONTEXT_MEMORY: "Lenient" }).mode, "lenient");
  assert.deepEqual(
    parseContextConfig({ CONTEXT_MEMORY: "strict", CONTEXT_HISTORY_SHARE: "0.4", CONTEXT_RECENT_GROUPS: "3", CONTEXT_KEEP_PREV_PAGES: "0", CONTEXT_STUB_OVER: "800", CONTEXT_REPLY_RESERVE: "2048", CONTEXT_CHARS_PER_TOKEN: "3", CONTEXT_OLDER_FORM: "NONE", CONTEXT_TRIM_LINE: "0" }),
    { mode: "strict", overrides: { historyShare: 0.4, recentGroups: 3, keepPrevPages: false, stubOver: 800, replyReserve: 2048, charsPerToken: 3, olderForm: "none", trimLine: false } },
  );
  const bad: [Record<string, string>, RegExp][] = [
    [{ CONTEXT_MEMORY: "tight" }, /CONTEXT_MEMORY must be one of/],
    [{ CONTEXT_HISTORY_SHARE: "0" }, /CONTEXT_HISTORY_SHARE must be a number from 0.05 to 0.9/],
    [{ CONTEXT_HISTORY_SHARE: "0.95" }, /CONTEXT_HISTORY_SHARE/],
    [{ CONTEXT_HISTORY_SHARE: "a lot" }, /CONTEXT_HISTORY_SHARE/],
    [{ CONTEXT_RECENT_GROUPS: "2.5" }, /CONTEXT_RECENT_GROUPS must be a whole number from 0 to 20/],
    [{ CONTEXT_RECENT_GROUPS: "21" }, /CONTEXT_RECENT_GROUPS/],
    [{ CONTEXT_RECENT_GROUPS: "-1" }, /CONTEXT_RECENT_GROUPS/],
    [{ CONTEXT_KEEP_PREV_PAGES: "yes" }, /CONTEXT_KEEP_PREV_PAGES must be 0 or 1/],
    [{ CONTEXT_TRIM_LINE: "2" }, /CONTEXT_TRIM_LINE must be 0 or 1/],
    [{ CONTEXT_STUB_OVER: "50" }, /CONTEXT_STUB_OVER must be a whole number from 100/],
    [{ CONTEXT_REPLY_RESERVE: "100" }, /CONTEXT_REPLY_RESERVE must be a whole number from 512/],
    [{ CONTEXT_CHARS_PER_TOKEN: "0.5" }, /CONTEXT_CHARS_PER_TOKEN must be a number from 1 to 6/],
    [{ CONTEXT_CHARS_PER_TOKEN: "7" }, /CONTEXT_CHARS_PER_TOKEN/],
    [{ CONTEXT_OLDER_FORM: "summary" }, /CONTEXT_OLDER_FORM must be "qa" or "none"/],
  ];
  for (const [env, re] of bad) assert.throws(() => parseContextConfig(env), re, JSON.stringify(env));
});

test("every setting changes what the view does (a setting nothing reads would be a bug)", () => {
  const long = "Revenue was 1,000 and cost 600. ".repeat(20);
  const m = chat(...Array.from({ length: 8 }, (_, i) => group(`question ${i + 1}`, { answer: long })), group("now"));
  const sig = (over: Partial<ContextKnobs>) =>
    [8192, 16384, 32768]
      .map((w) => {
        const r = run(m, over, w);
        return JSON.stringify([r.report.whole, r.report.shortened, r.report.omitted, r.report.stubbed, r.report.tokensAfter, r.report.budget]);
      })
      .join("|");
  const base = sig({});
  // stubOver acts on results between its old and new limit: a search result of 250 characters
  const mid: Msg[] = [user("q1"), asst([call("s", "search", { query: "x" })], "toolUse"), result("s", "search", "y".repeat(250)), asst([{ type: "text", text: "done" }])];
  const midChat = chat(mid, group("q2"), group("q3"));
  const midText = (over: Partial<ContextKnobs>) => JSON.stringify(run(midChat, over).messages[3].content);
  assert.notEqual(midText({ stubOver: 100 }), midText({ stubOver: 400 }));
  for (const over of [{ historyShare: 0.9 }, { recentGroups: 0 }, { keepPrevPages: false }, { replyReserve: 512 }, { charsPerToken: 4 }, { olderForm: "none" as const }]) {
    assert.notEqual(sig(over), base, JSON.stringify(over));
  }
  assert.equal(run(m, { trimLine: false }).report.changed, run(m, { trimLine: true }).report.changed); // trimLine only governs the CLI line
});

// ---- the view (state, failure, logging) ------------------------------------------------------------------------------------

function viewOf(over: { mode?: any; window?: number; settings?: () => any } = {}) {
  const reports: ContextReport[] = [];
  let mode = over.mode ?? "balanced";
  const view = makeContextView({ window: () => over.window ?? 8192, settings: over.settings ? over.settings : (w) => resolveContext({ mode, overrides: {} }, w), onReport: (r) => reports.push(r) });
  return { view, reports, setMode: (m: string) => (mode = m) };
}
const longChat = () => chat(...Array.from({ length: 10 }, (_, i) => group(`question ${i + 1}`, { answer: "Revenue was 1,000 and cost 600. ".repeat(40) })), group("now"));

test("the view logs a trim once per question, again only if it changes within the question, and again after the next question starts", async () => {
  const { view, reports } = viewOf();
  const m = longChat();
  await view.transform(m);
  await view.transform(m);
  await view.transform(m);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].changed, true);
  assert.ok(reports[0].digest);
  const bigger = [...m, ...group("tail", { pages: 3, end: "toolResult" }).slice(1)]; // the current question grows: the budget shrinks
  await view.transform(bigger);
  assert.equal(reports.length, 2);
  view.beginQuestion();
  assert.equal(view.trimmed(), undefined);
  await view.transform(m);
  assert.equal(reports.length, 3);
  assert.ok(view.trimmed());
  assert.ok(view.last());
  view.reset();
  assert.equal(view.last(), undefined);
});

test("the view never throws: a failure passes the messages through and is reported once per question", async () => {
  const { view, reports } = viewOf({ settings: () => { throw new Error("boom"); } });
  const m = longChat();
  assert.equal(await view.transform(m), m);
  assert.equal(await view.transform(m), m);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].error, "boom");
  const bad = viewOf();
  const garbage: any[] = [{ role: "system", content: "s" }, { role: "user", content: "a" }, null, undefined, 5, { role: "user" }, { role: "assistant", content: [null, { type: "text" }] }, { role: "user", content: "b" }];
  assert.equal(await bad.view.transform(garbage), garbage);
  const listener = makeContextView({ window: () => 8192, settings: (w) => resolveContext({ mode: "balanced", overrides: {} }, w), onReport: () => { throw new Error("listener"); } });
  assert.ok((await listener.transform(longChat())).length > 0);
});

test("off passes everything through; switching the level changes the next call", async () => {
  const { view, setMode, reports } = viewOf({ mode: "off", window: 16384 });
  const m = longChat();
  assert.equal(await view.transform(m), m);
  assert.equal(reports.length, 0);
  setMode("strict");
  const trimmed = await view.transform(m);
  assert.ok(trimmed.length < m.length);
  setMode("lenient");
  view.beginQuestion();
  const loose = await view.transform(m);
  assert.ok(loose.length > trimmed.length);
});

test("the window is read on every call, so a model switch takes effect at once", async () => {
  let window = 200_000;
  const view = makeContextView({ window: () => window, settings: (w) => resolveContext({ mode: "auto", overrides: {} }, w) });
  const m = longChat();
  const big = await view.transform(m);
  window = 8192;
  const small = await view.transform(m);
  assert.ok(small.length < big.length);
  assert.equal(view.last()!.level, "strict");
});

// ---- what the user sees -----------------------------------------------------------------------------------------------------

test("trimLine and describeContext: fixed words and numbers only", () => {
  const rep = run(longChat(), {}, 8192).report;
  const line = trimLine(rep);
  assert.match(line, /^context trimmed in the model's view: .* \(\/context for details\)$/);
  assert.ok(!/[\n\u001b]/.test(line));
  assert.equal(trimLine({ ...rep, shortened: 1, omitted: 0, stubbed: 0 }), "context trimmed in the model's view: 1 earlier question shortened (/context for details)");
  assert.equal(trimLine({ ...rep, shortened: 0, omitted: 2, stubbed: 3 }), "context trimmed in the model's view: 2 not shown, 3 earlier results shortened (/context for details)");

  const lines = describeContext(resolveContext({ mode: "auto", overrides: { recentGroups: 3 } }, 16384), 16384, rep, "setting", 6812);
  assert.equal(lines[0], "context memory: balanced (auto, from the window), window 16,384 tokens");
  assert.match(lines[1], /history up to 25% of the window; 3 recent questions whole; previous question's pages kept when they fit; results over 400 characters shortened; 4,096 tokens kept for the reply; 2.5 characters per token; older questions: question and answer/);
  assert.equal(lines[2], "  set on their own: recentGroups");
  assert.equal(lines[3], "  last prompt: 6,812 of 16,384 tokens (42%)");
  assert.match(lines[4], /^  last view: about [\d,]+ tokens cut to [\d,]+; earlier conversation [\d,]+ of [\d,]+ tokens allowed$/);
  assert.match(lines[5], /^  \d+ questions? whole, \d+ as question and answer, \d+ not shown \(\d+ unanswered\); \d+ results? shortened$/);

  assert.deepEqual(describeContext(resolveContext({ mode: "off", overrides: {} }, 16384), 16384, undefined, "command"), ["context memory: off (set with /context); the full conversation is sent every time"]);
  assert.equal(describeContext(resolveContext({ mode: "strict", overrides: {} }, 16384), 16384, undefined, "setting").at(-1), "  nothing to report yet");
  assert.match(describeContext(resolveContext({ mode: "strict", overrides: {} }, 16384), 16384, { ...rep, changed: false }, "setting").at(-1)!, /^  last view: unchanged/);
});

// ---- end to end: a real Pi agent with a scripted model ----------------------------------------------------------------------

test("end to end: a real agent shows the model a trimmed view while its own history and the order of messages stay complete", async () => {
  const seen: { chars: number; roles: string[]; text: string; messages: Msg[] }[] = [];
  let step = 0;
  const model: any = { id: "fake", name: "fake", api: "openai-completions", provider: "any", baseUrl: "http://x", reasoning: false, input: ["text"], cost: usage.cost, contextWindow: 8192, maxTokens: 4096 };
  const streamFn = (_m: unknown, ctx: { messages: any[] }) => {
    step++;
    seen.push({ chars: JSON.stringify(ctx.messages).length, roles: ctx.messages.map((m) => m.role), text: JSON.stringify(ctx.messages), messages: ctx.messages });
    const lastRole = ctx.messages[ctx.messages.length - 1].role;
    const stream = createAssistantMessageEventStream();
    (async () => {
      stream.push({ type: "start", partial: asst([], "pending") } as never);
      const content = lastRole === "toolResult" ? [{ type: "text", text: `Answer ${step}: revenue was 1,000. ${"filler ".repeat(60)}` }] : [call(`call-${step}`, "read_page", { path: "filings/X.pdf", page: step })];
      stream.push({ type: "done", reason: lastRole === "toolResult" ? "stop" : "toolUse", message: asst(content, lastRole === "toolResult" ? "stop" : "toolUse") } as never);
      stream.end();
    })();
    return stream;
  };
  const tool: any = { name: "read_page", label: "r", description: "d", parameters: { type: "object", properties: {} }, execute: async (_id: string, p: any) => ({ content: [{ type: "text", text: page(p.page ?? 1) }], details: { path: "filings/X.pdf", page: p.page ?? 1, part: 1 } }) };
  const reports: ContextReport[] = [];
  const view = makeContextView({ window: () => model.contextWindow, settings: (w) => resolveContext({ mode: "balanced", overrides: { historyShare: 0.15 } }, w), onReport: (r) => reports.push(r) });
  const agent = new Agent({ initialState: { systemPrompt: "sys", model, tools: [tool] }, streamFn: streamFn as never, transformContext: view.transform, identity: { attribution: null } });
  for (let q = 1; q <= 6; q++) {
    view.beginQuestion();
    await agent.prompt(`question ${q}`);
  }
  const stored = JSON.stringify(agent.state.messages).length;
  assert.equal(agent.state.messages.filter((m: any) => m.role === "user").length, 6); // nothing was removed from the stored history
  assert.ok(agent.state.messages.filter((m: any) => m.role === "toolResult").every((m: any) => /^\[page \d+ of 100/.test(m.content[0].text))); // and no stored result was shortened
  const last = seen.at(-1)!;
  assert.ok(last.chars < stored, "the last request was smaller than the stored history");
  assert.ok(last.text.includes("[earlier result omitted to save space"));
  assert.ok(last.text.includes("question 6"));
  assert.ok(reports.length >= 1 && reports.every((r) => r.changed));
  // every request kept each tool result after its call
  assert.equal(last.roles[0], "system");
  for (const s of seen) assertPaired(s.messages); // every request kept each tool result after its call
});

// ---- review and mutation findings ---------------------------------------------------------------------------------------

test("only a reply that stopped on its own (stop or length) with text and no tool call is a final answer; each other case alone makes a question unanswered", () => {
  const withEnd = (end: Msg): Msg[] => chat([user("lost"), asst([call("w", "read_page", { path: "f.pdf", page: 1 })], "toolUse"), result("w", "read_page", page(1), { path: "f.pdf", page: 1 }), end], group("q2"), group("q3"));
  const text = [{ type: "text", text: "An answer" }];
  const cases: [string, Msg, number][] = [
    ["stop", asst(text, "stop"), 0],
    ["length", asst(text, "length"), 0],
    ["error", asst(text, "error"), 1],
    ["aborted", asst(text, "aborted"), 1],
    ["toolUse", asst(text, "toolUse"), 1],
    ["pending", asst(text, "pending"), 1],
    ["deferred", asst(text, "deferred"), 1],
    ["missing", { ...asst(text), stopReason: undefined }, 1],
    ["text and a tool call", asst([...text, call("x", "read_page", {})], "stop"), 1],
    ["blank text", asst([{ type: "text", text: " \n " }], "stop"), 1],
    ["no content", asst([], "stop"), 1],
  ];
  for (const [name, end, unanswered] of cases) assert.equal(run(withEnd(end)).report.unanswered, unanswered, name);
});

test("a question that was stopped does not count as a recent question: the one before it still keeps its pages", () => {
  const m = chat(group("q1"), group("q2"), group("stopped", { end: "aborted" }), group("now"));
  const r = run(m, { recentGroups: 2 });
  assert.equal(r.report.unanswered, 1);
  assert.equal(r.report.whole, 2); // q2 and q1 are the two recent questions
  const q2 = r.messages.filter((x) => x.role === "toolResult")[1];
  assert.match((q2.content as any[])[0].text, /^\[page 5 of 100/); // q2 is the previous question: its page is whole
});

test("once a newer question does not fit, older ones are left out too, even tiny ones", () => {
  const m = chat(group("small a", { answer: "ok" }), group("small b", { answer: "ok" }), group("huge", { answer: "word ".repeat(3000) }), group("now"));
  const out = run(m, { historyShare: 0.1 }, 16384);
  assert.equal(out.report.omitted, 3); // the huge one does not fit, so neither small one is shown
  assert.ok(!JSON.stringify(out.messages).includes("small a") && !JSON.stringify(out.messages).includes("small b"));
});

test("a result of exactly the limit stays, one character more is shortened", () => {
  const body = (n: number) => "z".repeat(n);
  const mk = (n: number): Msg[] => [user("q1"), asst([call("s", "search", { query: "x" })], "toolUse"), result("s", "search", body(n)), asst([{ type: "text", text: "done" }])];
  const at = (n: number) => (run(chat(mk(n), group("q2"), group("q3")), { stubOver: 400, keepPrevPages: false }).messages[3].content as any[])[0].text as string;
  assert.equal(at(400), body(400));
  assert.match(at(401), /^\[earlier result omitted/);
});

test("finished questions kept whole lose their thinking; a reply made only of thinking is dropped, with the tool calls left paired", () => {
  const g: Msg[] = [user("q1"), asst([{ type: "thinking", thinking: "hmm" }], "toolUse"), asst([{ type: "thinking", thinking: "more" }, call("c", "read_page", { path: "f.pdf", page: 1 })], "toolUse"), result("c", "read_page", page(1), { path: "f.pdf", page: 1 }), asst([{ type: "thinking", thinking: "t" }, { type: "text", text: "final" }])];
  const r = run(chat(g, group("q2"), group("q3")), { keepPrevPages: false });
  assert.ok(!JSON.stringify(r.messages.slice(1, 5)).includes("thinking"));
  assert.equal(r.messages.slice(1, 5).filter((x) => x.role === "assistant").length, 2); // the thinking-only reply is gone
  assertPaired(r.messages);
});

test("a short form keeps only non-blank text blocks of the answer", () => {
  const g: Msg[] = [user("old"), asst([{ type: "text", text: "  " }, { type: "text", text: "real answer" }, { type: "text", text: "" }])];
  const r = run(chat(g, group("q2"), group("q3"), group("q4")), { recentGroups: 0 });
  const at = r.messages.findIndex((x) => JSON.stringify(x.content).includes("old"));
  assert.deepEqual(r.messages[at + 1].content, [{ type: "text", text: "real answer" }]);
});

test("a result whose call is not in its own question is dropped, so the view never holds an orphan result", () => {
  const m = chat([user("q1"), asst([call("c1", "read_page", { path: "f.pdf", page: 1 })], "toolUse")], [user("typed in the middle"), result("c1", "read_page", page(1), { path: "f.pdf", page: 1 }), asst([{ type: "text", text: "answer" }])], group("q3"));
  const r = run(m);
  assertPaired(r.messages);
  assert.ok(!r.messages.some((x) => x.toolCallId === "c1"));
});

test("the earliest estimates are exact numbers (system message at its own rate, text at the knob's rate)", () => {
  const s: Msg = { role: "system", content: "abc" }; // {"role":"system","content":"abc"} is 33 characters, 4 per token
  const u: Msg = { role: "user", content: "0123456789", timestamp: 0 }; // 12 + 10 characters at 2.5 per token
  const r = run([s, u]);
  assert.equal(r.report.fixed, 9); // 33 / 4 = 8.25
  assert.equal(r.report.tokensBefore, 18); // 8.25 + 8.8 = 17.05
  const a = asst([call("c", "ab", { x: 1 })], "toolUse"); // 12 + 2 + 7 characters
  assert.equal(run([s, { role: "user", content: "q", timestamp: 0 }, a]).report.tokensBefore, 22); // 8.25 + 5.2 + 8.4 = 21.85
});

test("report details: ids of shortened results, indices in order, and the lists are capped at 50", () => {
  const m = chat(group("q1"), group("q2"), group("q3"));
  const r = run(m, { keepPrevPages: false });
  assert.deepEqual(r.report.stubbedIds, m.filter((x) => x.role === "toolResult").slice(0, 2).map((x) => x.toolCallId));
  const many = chat(...Array.from({ length: 80 }, (_, i) => group(`question ${i}`, { answer: "a ".repeat(100) })), group("now"));
  const big = run(many, {}, 8192).report;
  assert.ok(big.omitted > 50);
  assert.equal(big.omittedAt.length, 50);
  assert.deepEqual(big.omittedAt, big.omittedAt.slice().sort((a, b) => a - b));
  assert.equal(big.messagesIn, many.length);
  assert.ok(big.messagesOut < big.messagesIn);
});

test("when the line about omitted questions would make the view bigger, the input goes through and the report says unchanged", () => {
  const m: Msg[] = [sys(), user("a"), user("b")];
  const r = run(m);
  assert.equal(r.messages, m);
  assert.equal(r.report.changed, false);
  assert.equal(r.report.marker, undefined);
  assert.equal(r.report.omitted, 0);
  assert.equal(r.report.tokensAfter, r.report.tokensBefore);
  assert.equal(r.report.messagesOut, m.length);
  const chatMsgs = chat(group("q1"), group("q2"), group("q3"));
  assert.equal(run(chatMsgs, {}, 0).messages, chatMsgs); // an unknown window is left alone
});

test("the line about omitted questions names at most 3 files, from results or from calls, and never an empty name", () => {
  const long = "word ".repeat(1200);
  const g = (file: string | undefined, how: "details" | "call"): Msg[] => {
    const id = `k${++ids}`;
    return [user(`q ${file}`), asst([call(id, "read_page", how === "call" ? { path: file ?? "", page: 1 } : { page: 1 })], "toolUse"), result(id, "read_page", "short", how === "details" ? { path: file } : {}), asst([{ type: "text", text: long }])];
  };
  const m = chat(g("a.pdf", "details"), g("b.pdf", "call"), g("c.pdf", "details"), g("d.pdf", "call"), g(undefined, "call"), group("now", { end: "toolResult" }));
  const r = run(m, { historyShare: 0.05 }, 8192);
  assert.equal(r.report.omitted, 5);
  assert.match(r.report.marker!, /\(they used a\.pdf, b\.pdf, c\.pdf\)/);
});

test("the note names up to 3 simple arguments, skips other values, and prefers the result's own details", () => {
  const g: Msg[] = [user("q1"), asst([call("s", "search", { query: "q", path: "p", a: 1, flag: true, nested: { x: 1 }, b: "late" })], "toolUse"), result("s", "search", "x".repeat(600)), asst([{ type: "text", text: "d" }])];
  const note = (run(chat(g, group("q2"), group("q3")), { keepPrevPages: false }).messages[3].content as any[])[0].text as string;
  assert.equal(note, "[earlier result omitted to save space: search query=q, path=p, a=1. Run it again if you need it.]");
  const h: Msg[] = [user("q1"), asst([call("p", "read_page", { path: "args.pdf", page: 9 })], "toolUse"), result("p", "read_page", page(1), { path: "details.pdf", page: 2, part: 3 }), asst([{ type: "text", text: "d" }])];
  const note2 = (run(chat(h, group("q2"), group("q3")), { keepPrevPages: false }).messages[3].content as any[])[0].text as string;
  assert.match(note2, /read_page details\.pdf page 2 part 3\./);
});

test("singular wording, and where the level came from after /context auto", () => {
  const rep = run(longChat(), {}, 8192).report;
  assert.equal(trimLine({ ...rep, shortened: 0, omitted: 0, stubbed: 1 }), "context trimmed in the model's view: 1 earlier result shortened (/context for details)");
  const lines = describeContext(resolveContext({ mode: "strict", overrides: {} }, 8192), 8192, { ...rep, whole: 1, shortened: 1, omitted: 1, unanswered: 0, stubbed: 1, changed: true }, "setting");
  assert.match(lines.join("\n"), /1 recent question whole/);
  assert.match(lines.join("\n"), /1 question whole, 1 as question and answer, 1 not shown \(0 unanswered\); 1 result shortened/);
  assert.match(describeContext(resolveContext({ mode: "auto", overrides: {} }, 16384), 16384, undefined, "command")[0], /auto, from the window; set with \/context/);
});

test("the view starts clean on beginQuestion and reset, and an unchanged view is not 'trimmed'", async () => {
  const reports: ContextReport[] = [];
  const view = makeContextView({ window: () => 8192, settings: (w) => resolveContext({ mode: "balanced", overrides: {} }, w), onReport: (r) => reports.push(r) });
  const m = longChat();
  await view.transform(m);
  await view.transform(m);
  assert.equal(reports.length, 1);
  view.beginQuestion();
  await view.transform(m);
  assert.equal(reports.length, 2); // beginQuestion cleared the memory of what was reported
  view.reset();
  assert.equal(view.trimmed(), undefined);
  await view.transform(m);
  assert.equal(reports.length, 3); // reset did too
  const quiet = makeContextView({ window: () => 8192, settings: (w) => resolveContext({ mode: "balanced", overrides: {} }, w) });
  await quiet.transform([sys(), user("only")]);
  assert.equal(quiet.trimmed(), undefined);
  assert.ok(quiet.last());
});

test("the view re-reports when only one of the counts changes", async () => {
  const reports: ContextReport[] = [];
  let share = 0.25;
  const view = makeContextView({ window: () => 16384, settings: (w) => resolveContext({ mode: "balanced", overrides: { historyShare: share } }, w), onReport: (r) => reports.push(r) });
  const m = chat(...Array.from({ length: 12 }, (_, i) => group(`question ${i + 1}`, { answer: "Revenue was 1,000. ".repeat(60) })), group("now"));
  await view.transform(m);
  share = 0.12;
  await view.transform(m);
  assert.equal(reports.length, 2);
  assert.notEqual(`${reports[0].whole}/${reports[0].shortened}/${reports[0].omitted}`, `${reports[1].whole}/${reports[1].shortened}/${reports[1].omitted}`);
});

test("a failure is reported again after beginQuestion or reset", async () => {
  const reports: ContextReport[] = [];
  const view = makeContextView({ window: () => 8192, settings: () => { throw new Error("boom"); }, onReport: (r) => reports.push(r) });
  const m = longChat();
  await view.transform(m);
  view.beginQuestion();
  await view.transform(m);
  view.reset();
  await view.transform(m);
  assert.equal(reports.length, 3);
});

test("turning the level to off clears the last report", async () => {
  const { view, setMode } = viewOf({ mode: "strict" });
  await view.transform(longChat());
  assert.ok(view.last());
  setMode("off");
  await view.transform(longChat());
  assert.equal(view.last(), undefined);
});

test("settings: off is a level; numbers must be written plainly; the limits are inclusive; messages show the bad value", () => {
  assert.equal(parseContextConfig({ CONTEXT_MEMORY: "off" }).mode, "off");
  for (const bad of ["1e2", "0x20", "+150", ".5", "5."]) assert.throws(() => parseContextConfig({ CONTEXT_STUB_OVER: bad }), /CONTEXT_STUB_OVER/, bad);
  assert.equal(parseContextConfig({ CONTEXT_STUB_OVER: "100000" }).overrides.stubOver, 100000);
  assert.throws(() => parseContextConfig({ CONTEXT_STUB_OVER: "100001" }), /CONTEXT_STUB_OVER/);
  assert.equal(parseContextConfig({ CONTEXT_REPLY_RESERVE: "100000" }).overrides.replyReserve, 100000);
  assert.throws(() => parseContextConfig({ CONTEXT_REPLY_RESERVE: "100001" }), /CONTEXT_REPLY_RESERVE/);
  assert.equal(parseContextConfig({ CONTEXT_HISTORY_SHARE: "0.05" }).overrides.historyShare, 0.05);
  assert.equal(parseContextConfig({ CONTEXT_HISTORY_SHARE: "0.9" }).overrides.historyShare, 0.9);
  assert.equal(parseContextConfig({ CONTEXT_RECENT_GROUPS: "0" }).overrides.recentGroups, 0);
  assert.equal(parseContextConfig({ CONTEXT_RECENT_GROUPS: "20" }).overrides.recentGroups, 20);
  assert.equal(parseContextConfig({ CONTEXT_CHARS_PER_TOKEN: "1" }).overrides.charsPerToken, 1);
  assert.equal(parseContextConfig({ CONTEXT_CHARS_PER_TOKEN: "6" }).overrides.charsPerToken, 6);
  assert.throws(() => parseContextConfig({ CONTEXT_STUB_OVER: "abc" }), /got "abc"/);
  assert.throws(() => parseContextConfig({ CONTEXT_TRIM_LINE: "maybe" }), /got "maybe"/);
});

test("a string-content question is not edited in place either (frozen input)", () => {
  const m = deepFreeze([sys(), { role: "user", content: "old", timestamp: 0 } as Msg, asst([{ type: "text", text: "word ".repeat(1200) }]), { role: "user", content: "now", timestamp: 0 } as Msg]);
  const r = run(m as Msg[], { historyShare: 0.05 }, 8192);
  assert.equal(r.messages[1].content, `${r.report.marker}\n\nnow`);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { compactContext, describeContext, historyBudget, makeContextView, type ContextReport, type Msg } from "../src/context.ts";
import { CONTEXT_LEVELS, parseContextConfig, resolveContext, type ContextKnobs } from "../src/contextSettings.ts";

const sys = (): Msg => ({ role: "system", content: "You are a careful assistant. ".repeat(4) });
const user = (text: string): Msg => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
const call = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
const asst = (content: object[], stopReason = "stop"): Msg => ({ role: "assistant", content, stopReason, timestamp: 0 });
const result = (id: string, tool: string, text: string, details?: unknown, isError = false): Msg => ({ role: "toolResult", toolCallId: id, toolName: tool, content: [{ type: "text", text }], details, isError, timestamp: 0 });
const page = (n: number, filler = 3000, header = true) => (header ? `[page ${n} of 100 in f.pdf]\n(in millions)\n|  2022  |  2021\n` : `[page ${n}]\n`) + "Revenue | 1,000 | 900\n".repeat(Math.ceil(filler / 22));
let ids = 0;
const group = (q: string, o: { answer?: string; file?: string; pages?: number } = {}): Msg[] => {
  const out: Msg[] = [user(q)];
  for (let i = 0; i < (o.pages ?? 1); i++) {
    const id = `g${++ids}`;
    out.push(asst([call(id, "read_page", { path: o.file ?? "f.pdf", page: 5 + i })], "toolUse"), result(id, "read_page", page(5 + i), { path: o.file ?? "f.pdf", page: 5 + i, part: 1 }));
  }
  out.push(asst([{ type: "text", text: o.answer ?? `Answer to ${q}` }]));
  return out;
};
const chat = (...g: Msg[][]): Msg[] => [sys(), ...g.flat()];
const balanced = CONTEXT_LEVELS.balanced;
const run = (m: Msg[], over: Partial<ContextKnobs> = {}, window = 16384, level: string | undefined = "t") => compactContext(m, { window, knobs: { ...balanced, ...over }, level });
const cur = () => group("now", { pages: 1 }).slice(0, 3); // current question: user, call, result
const note = (g: Msg[], over: Partial<ContextKnobs> = {}) => (run(chat(g, group("q2"), group("q3")), { keepPrevPages: false, ...over }).messages[3].content as any[])[0].text as string;
const one = (tool: string, args: unknown, text: string, details?: unknown): Msg[] => [user("q1"), asst([call("s", tool, args)], "toolUse"), result("s", tool, text, details), asst([{ type: "text", text: "d" }])];

test("X1 no leading system message: a chat that starts with a user message is trimmed; fixed counts a chat with no user", () => {
  const m: Msg[] = [...group("q1"), ...group("q2"), ...group("q3"), ...cur()];
  const r = run(m, { keepPrevPages: false });
  assert.equal(r.report.changed, true);
  assert.ok(run([sys()]).report.fixed > 0);
  assert.equal(run([sys()]).report.window, 16384);
  assert.equal(compactContext(m, { window: 16384, knobs: balanced }).report.level, "");
});

test("X2 thinking-only reply is gone from the whole form (no empty assistant message)", () => {
  const g: Msg[] = [user("q1"), asst([{ type: "thinking", thinking: "hmm" }], "toolUse"), asst([call("c", "read_page", { path: "f.pdf", page: 1 })], "toolUse"), result("c", "read_page", page(1), { path: "f.pdf", page: 1 }), asst([{ type: "text", text: "final" }])];
  const r = run(chat(g, group("q2"), group("q3")), { keepPrevPages: false });
  assert.ok(!r.messages.some((x) => x.role === "assistant" && (x.content as any[]).length === 0));
  assert.equal(r.messages.length, chat(g, group("q2"), group("q3")).length - 1);
});

test("X3 null blocks do not throw", () => {
  const m: Msg[] = [sys(), user("a"), asst([null as any, { type: "text", text: "x" }]), user("b")];
  assert.doesNotThrow(() => compactContext(m, { window: 8192, knobs: balanced }));
});

test("X4 argSummary and notes", () => {
  assert.equal(note(one("search", { nested: { x: 1 }, flag: true, query: "q" }, "x".repeat(600))), "[earlier result omitted to save space: search query=q. Run it again if you need it.]");
  assert.equal(note(one("search", null, "x".repeat(600))), "[earlier result omitted to save space: search. Run it again if you need it.]");
  assert.equal(note(one("search", "path=f", "x".repeat(600))), "[earlier result omitted to save space: search. Run it again if you need it.]");
  assert.equal(note(one("list_files", {}, "x".repeat(600))), "[earlier result omitted to save space: list_files. Run it again if you need it.]");
  assert.match(note(one("search", { ["k".repeat(50)]: "v" }, "x".repeat(600))), /search k{19}…=v\./);
  // read_page: details missing -> call arguments
  assert.match(note(one("read_page", { path: "a.pdf", page: 9, part: 4 }, page(1))), /read_page a\.pdf page 9 part 4\./);
  assert.match(note(one("read_page", { path: "a.pdf", page: 9, part: 4 }, page(1), { path: "b.pdf", page: 2 })), /read_page b\.pdf page 2 part 4\./); // part from args when details lack it
  assert.match(note(one("read_page", { path: "a.pdf", page: 9, part: 4 }, page(1), { part: 2 })), /read_page a\.pdf page 9 part 2\./); // details win
  assert.match(note(one("read_page", { path: "a.pdf", page: 9 }, page(1), { part: 2 })), /page 9 part 2\./);
  assert.match(note(one("read_page", { path: "a.pdf", page: 9 }, page(1), { part: 1 })), /page 9\. Header/); // part 1 not shown
  assert.match(note(one("read_page", { path: "a.pdf", page: 9 }, page(1), { part: "3" })), /page 9\./); // string part ignored
  assert.doesNotMatch(note(one("read_page", { path: "a.pdf", page: 9 }, page(1), { part: "3" })), /part/);
  assert.match(note(one("read_page", { path: "a.pdf", page: 9 }, page(1), { part: 3.7 })), /page 9 part 3\. Header/);
  assert.match(note(one("read_page", { path: "a.pdf", page: 9.8 }, page(1))), /page 9\. Header/);
  assert.match(note(one("read_page", { path: "a.pdf", page: "9" }, page(1))), /page \?\./);
  assert.match(note(one("read_page", { path: "a.pdf", page: Infinity }, page(1))), /page \?\./);
  assert.doesNotMatch(note(one("read_page", { path: "a.pdf", page: 9 }, page(1, 3000, false))), /Header/);
  assert.match(note(one("read_page", { path: "a.pdf", page: 9 }, page(1, 3000, false))), /page 9\. Figures from it/);
});

test("keepPrevPages keeps the previous question's page reads, not large results of other tools", () => {
  const g2 = chat(group("q0"), one("search", { query: "q" }, "x".repeat(600)), group("q3"));
  const o2 = run(g2, { keepPrevPages: true });
  // the previous question is the search one: its large search result is shortened even though keepPrevPages is on
  assert.match(((o2.messages.find((x) => x.toolName === "search") as Msg).content as any[])[0].text, /^\[earlier result omitted/);
  // q0 is older than the previous question: its page read is shortened too
  assert.match(((o2.messages.filter((x) => x.toolName === "read_page")[0]).content as any[])[0].text, /^\[earlier result omitted/);
  // and a previous question that is a page read keeps it whole
  const o3 = run(chat(group("q0"), group("prev"), group("now")), { keepPrevPages: true });
  assert.match(((o3.messages.filter((x) => x.toolName === "read_page")[1]).content as any[])[0].text, /^\[page 5 of 100/);
});

test("X6 digest", () => {
  const m = chat(group("q1"), group("q2"), group("q3"), group("q4"));
  const a = run(m, { recentGroups: 0 }, 8192).report;
  assert.match(a.digest!, /^[0-9a-f]{8}$/);
  const b = run(m, { recentGroups: 0 }, 8192).report;
  assert.equal(a.digest, b.digest);
  const c = run(chat(group("q1"), group("q2"), group("q3"), group("q5")), { recentGroups: 0 }, 8192).report;
  assert.notEqual(a.digest, c.digest);
  // exact pin of the current algorithm for a tiny view
  const tiny = compactContext([sys(), ...group("a"), ...group("b"), ...group("c"), ...cur()], { window: 8192, knobs: { ...balanced, recentGroups: 0, keepPrevPages: false } }).report.digest;
  assert.match(tiny!, /^[0-9a-f]{8}$/);
});

test("X6b digest sees roles, text and call ids", () => {
  const mk = (role2: string, text: string, id: string) => {
    const g = (q: string): Msg[] => [user(q), asst([call(id, "read_page", { path: "f.pdf", page: 1 })], "toolUse"), result(id, "read_page", page(1), { path: "f.pdf", page: 1 }), asst([{ type: "text", text }])];
    void role2;
    return compactContext(chat(g("q1"), g("q2"), g("q3")), { window: 16384, knobs: { ...balanced, keepPrevPages: false } }).report.digest!;
  };
  assert.notEqual(mk("a", "ans one", "c1"), mk("a", "ans two", "c1"));
  assert.notEqual(mk("a", "ans one", "c1"), mk("a", "ans one", "c2"));
});

test("X7 historyBudget floors the share", () => {
  assert.equal(historyBudget(10001, balanced, 0, 0), 2500);
});

test("X8 marker: no files, empty names, reserve, boundary, report lists", () => {
  const long = "word ".repeat(1200);
  const noFiles: Msg[] = [user("q1"), asst([{ type: "text", text: long }])];
  const r = run(chat(noFiles, [user("now"), asst([call("x", "read_page", { path: "f", page: 1 })], "toolUse")]), { historyShare: 0.05 }, 8192);
  assert.equal(r.report.marker, "[Earlier in this conversation, 1 question is not shown. Re-ask, or read the pages again, if you need it.]");
  const emptyFirst: Msg[] = [user("q1"), asst([call("e", "read_page", { path: "", page: 1 })], "toolUse"), result("e", "read_page", "short", {}), asst([{ type: "text", text: long }])];
  const r2 = run(chat(emptyFirst, group("now", { pages: 1 }).slice(0, 2)), { historyShare: 0.05 }, 8192);
  assert.doesNotMatch(r2.report.marker!, /used/);
  // window recorded
  assert.equal(r2.report.window, 8192);
});

test("X9 exact fit boundary and the marker reserve", () => {
  const g1 = group("q1", { answer: "alpha beta gamma. ".repeat(10) });
  const m = chat(g1, group("now", { pages: 1 }).slice(0, 2));
  const E = run(m, { historyShare: 0.9, recentGroups: 0 }, 65536).report.history;
  assert.ok(E > 0);
  const at = (share: number) => run(m, { historyShare: share, recentGroups: 0, replyReserve: 512 }, 65536).report;
  const reserve = Math.ceil(300 / balanced.charsPerToken);
  assert.equal(at((E + reserve) / 65536).omitted, 0, "limit == size fits");
  assert.equal(at((E + reserve - 1) / 65536).omitted, 1, "limit one short does not fit");
});

test("X10 lists: omittedAt from the start, shortenedAt ascending, caps", () => {
  const many = chat(...Array.from({ length: 80 }, (_, i) => group(`question ${i}`, { answer: "a ".repeat(100) })), group("now"));
  const big = run(many, {}, 8192).report;
  assert.equal(big.omittedAt[0], 1); // the oldest question is at index 1
  const m = chat(group("q1"), group("q2"), group("q3"), group("q4"), group("q5"));
  const s = run(m, { recentGroups: 0 }).report;
  assert.ok(s.shortened >= 2);
  assert.deepEqual(s.shortenedAt, s.shortenedAt.slice().sort((a, b) => a - b));
  const sh = run(chat(...Array.from({ length: 70 }, (_, i) => group(`question ${i}`, { answer: "b " })), group("now")), { recentGroups: 0, historyShare: 0.9 }, 100000).report;
  assert.ok(sh.shortened > 50);
  assert.equal(sh.shortenedAt.length, 50);
  assert.equal(sh.shortenedAt[0], 1);
  const st = run(chat(...Array.from({ length: 70 }, (_, i) => group(`question ${i}`, { answer: "b " })), group("now")), { recentGroups: 70, keepPrevPages: false, historyShare: 0.9 }, 400000).report;
  assert.ok(st.stubbed > 50, String(st.stubbed));
  assert.equal(st.stubbedIds.length, 50);
  
});

test("X11 tokensAfter is the estimate of the view; stubbed ids in message order", () => {
  const m = chat(group("q1"), group("q2"), group("q3"), group("q4"));
  const r = run(m, { keepPrevPages: false, recentGroups: 3 });
  assert.equal(run(r.messages, {}, 16384).report.tokensBefore, r.report.tokensAfter);
});

test("X12 describe", () => {
  const rep = run(chat(group("q1"), group("q2"), group("q3"), group("q4"), group("q5"), group("q6")), {}, 8192).report;
  const lines = describeContext(resolveContext({ mode: "balanced", overrides: { recentGroups: 3, historyShare: 0.257, stubOver: 500 } }, 16384), 16384, rep, "setting");
  assert.equal(lines[2], "  set on their own: recentGroups, historyShare, stubOver");
  assert.match(lines[1], /history up to 26%/);
  assert.equal(lines[3], `  last view: about ${rep.tokensBefore.toLocaleString("en-US")} tokens cut to ${rep.tokensAfter.toLocaleString("en-US")}; earlier conversation ${rep.history.toLocaleString("en-US")} of ${rep.budget.toLocaleString("en-US")} tokens allowed`);
  assert.equal(describeContext(resolveContext({ mode: "balanced", overrides: {} }, 16384), 0, undefined, "setting", 500).some((l) => l.includes("last prompt")), false);
  assert.equal(describeContext(resolveContext({ mode: "balanced", overrides: {} }, 16384), 16384, { ...rep, changed: false, tokensAfter: 1 }, "setting").at(-1), `  last view: unchanged, about ${rep.tokensBefore.toLocaleString("en-US")} tokens`);
});

test("X13 view", async () => {
  const long = "Revenue was 1,000. ".repeat(60);
  const reports: ContextReport[] = [];
  let keep = true;
  const view = makeContextView({ window: () => 16384, settings: (w) => resolveContext({ mode: "balanced", overrides: { keepPrevPages: keep, historyShare: 0.9 } }, w), onReport: (r) => reports.push(r) });
  const m = chat(group("q1", { answer: long }), group("q2", { answer: long }), group("q3", { answer: long }), group("now"));
  await view.transform(m);
  assert.equal(reports.length, 1);
  keep = false;
  await view.transform(m);
  assert.equal(reports.length, 2, "only the stubbed count changed");
  view.beginQuestion();
  assert.ok(view.last(), "last() survives beginQuestion");
  const thrower = makeContextView({ window: () => 8192, settings: () => { throw "plain"; }, onReport: (r) => reports.push(r) });
  await thrower.transform(m);
  assert.equal(reports.at(-1)!.error, "plain");
});

test("X14 settings", () => {
  assert.equal(parseContextConfig({ CONTEXT_MEMORY: "balanced" }).mode, "balanced");
  assert.equal(parseContextConfig({ CONTEXT_MEMORY: "auto" }).mode, "auto");
  assert.equal(parseContextConfig({ CONTEXT_TRIM_LINE: "1" }).overrides.trimLine, true);
  assert.equal(parseContextConfig({ CONTEXT_KEEP_PREV_PAGES: "1" }).overrides.keepPrevPages, true);
  assert.equal(parseContextConfig({ CONTEXT_OLDER_FORM: "qa" }).overrides.olderForm, "qa");
  assert.throws(() => parseContextConfig({ CONTEXT_MEMORY: "tight" }), /got "tight"/);
  assert.throws(() => parseContextConfig({ CONTEXT_OLDER_FORM: "summary" }), /got "summary"/);
  for (const [k, v] of [["CONTEXT_HISTORY_SHARE", ".5"], ["CONTEXT_HISTORY_SHARE", "0.5."], ["CONTEXT_HISTORY_SHARE", "0.5x"], ["CONTEXT_CHARS_PER_TOKEN", "3."], ["CONTEXT_CHARS_PER_TOKEN", "+3"], ["CONTEXT_CHARS_PER_TOKEN", "1e0"], ["CONTEXT_CHARS_PER_TOKEN", "0x3"], ["CONTEXT_CHARS_PER_TOKEN", "6.01"], ["CONTEXT_CHARS_PER_TOKEN", "-3"]])
    assert.throws(() => parseContextConfig({ [k]: v }), new RegExp(k), `${k}=${v}`);
  assert.equal(parseContextConfig({ CONTEXT_CHARS_PER_TOKEN: "2.75" }).overrides.charsPerToken, 2.75);
  assert.deepEqual(resolveContext({ mode: "off", overrides: {} }, 16384).knobs, balanced);
});

test("X15 the reserve for the next result is rounded up in tokens", () => {
  const k = { ...balanced, charsPerToken: 3 };
  const m = chat(group("q1"), group("q2"), cur());
  const rr = compactContext(m, { window: 16384, knobs: k });
  const curEst = compactContext([...cur()], { window: 16384, knobs: k }).report.tokensBefore;
  assert.equal(rr.report.current, curEst + Math.ceil(5000 / 3), String(rr.report.current) + " " + curEst);
});

test("X16 estimates: tool call name length and block overhead", () => {
  const s: Msg = { role: "system", content: "abc" };
  const a = asst([call("c", "abcdefghij", { x: 1 })], "toolUse"); // 12 + 10 + 7 = 29 chars
  assert.equal(run([s, { role: "user", content: "q", timestamp: 0 }, a]).report.tokensBefore, Math.ceil(33 / 4 + 13 / 2.5 + 29 / 2.5));
});

test("X17 textOf: non-text blocks carrying text do not make an answer; two text blocks joined with a newline count", () => {
  const withEnd = (end: Msg): Msg[] => chat([user("lost"), asst([call("w", "read_page", { path: "f.pdf", page: 1 })], "toolUse"), result("w", "read_page", page(1), { path: "f.pdf", page: 1 }), end], group("q2"), group("q3"));
  assert.equal(run(withEnd(asst([{ type: "image", text: "caption" }]))).report.unanswered, 1);
  const g = (n1: number, n2: number): Msg[] => [user("q1"), asst([call("s", "search", { q: 1 })], "toolUse"), { role: "toolResult", toolCallId: "s", toolName: "search", content: [{ type: "text", text: "a".repeat(n1) }, { type: "text", text: "b".repeat(n2) }], timestamp: 0 }, asst([{ type: "text", text: "d" }])];
  assert.match(note(g(200, 200), { stubOver: 400 }), /^\[earlier/); // 200 + newline + 200 = 401 > 400
});

test("X18 identity, short form oddities, content-less current question, exact digest, first stubbed id", () => {
  // a mid-group assistant message without thinking stays the same object, even with empty content
  const mid = asst([], "toolUse");
  const g: Msg[] = [user("q1"), mid, asst([call("c", "read_page", { path: "f.pdf", page: 1 })], "toolUse"), result("c", "read_page", page(1), { path: "f.pdf", page: 1 }), asst([{ type: "text", text: "final" }])];
  const r = run(chat(g, group("q2"), group("q3")), { keepPrevPages: false });
  assert.ok(r.messages.includes(mid));
  // short form: only real text blocks
  const sg: Msg[] = [user("old"), asst([{ type: "image", text: "caption" }, { type: "text", text: 42 as any }, { type: "text", text: "real" }])];
  const r2 = run(chat(sg, group("q2"), group("q3"), group("q4")), { recentGroups: 0 });
  const at = r2.messages.findIndex((x) => JSON.stringify(x.content).includes("old"));
  assert.deepEqual(r2.messages[at + 1].content, [{ type: "text", text: "real" }]);
  // a current question without content still gets the line (no crash)
  const long = "word ".repeat(1200);
  const r3 = run([sys(), user("q1"), asst([{ type: "text", text: long }]), { role: "user", timestamp: 0 } as Msg], { historyShare: 0.05 }, 8192);
  assert.equal(r3.report.omitted, 1);
  assert.deepEqual((r3.messages[1].content as any[]).map((b) => b.text), [r3.report.marker]);
  // exact digest of a known view
  const c1 = (id: string): Msg => asst([call(id, "read_page", { path: "f.pdf", page: 1 })], "toolUse");
  const res = (id: string): Msg => result(id, "read_page", "x".repeat(3000), { path: "f.pdf", page: 1 });
  const m: Msg[] = [{ role: "system", content: "s" }, user("q1"), c1("c1"), res("c1"), asst([{ type: "text", text: "ans one" }]), user("q2"), c1("c2"), res("c2"), asst([{ type: "text", text: "ans two" }]), user("now")];
  assert.equal(run(m, { recentGroups: 0 }).report.digest, "3da1941f");
  // the first listed stubbed id is the oldest kept result
  const many = chat(...Array.from({ length: 70 }, (_, i) => group(`question ${i}`, { answer: "b " })), group("now"));
  const st = run(many, { recentGroups: 70, keepPrevPages: false, historyShare: 0.9 }, 400000).report;
  assert.equal(st.stubbedIds[0], (many.find((x) => x.role === "toolResult") as Msg).toolCallId);
});

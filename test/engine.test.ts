import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { openWorkspace, type Workspace } from "../src/workspace.ts";
import { createDocStore } from "../src/documents/store.ts";
import { PdfError, type ParsedPdf } from "../src/documents/pdf.ts";
import { createEngine, type Engine } from "../src/engine.ts";
import { reasoningProfile } from "../src/reasoning.ts";
import { loadConfig } from "../src/config.ts";
import { extractNumbers, normalise } from "../src/provenance.ts";
import * as D from "./fixtures/docKinds.ts";

const createNum = (s: string) => extractNumbers(normalise(s))[0];

// Whole questions through the real engine (real Pi agent, tools, guard, ledger, checks, references, audit records) with a
// scripted model: no Ollama, no network.
const PAGE = ["Consolidated Statements of Income", "(in millions)", "Year ended December 31  |  2022  |  2021", "Net sales  |  32,765  |  31,009", "Net income  |  5,921  |  5,100"].join("\n");

let base: string;
let ws: Workspace;
before(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "finh-engine-")));
  fs.mkdirSync(path.join(base, "ws"), { recursive: true });
  fs.mkdirSync(path.join(base, "project"));
  fs.writeFileSync(path.join(base, "ws", "a.pdf"), "fake");
  ws = openWorkspace(path.join(base, "ws"), path.join(base, "project"), []);
});
after(() => fs.rmSync(base, { recursive: true, force: true }));

interface Rig {
  engine: Engine;
  faux: ReturnType<typeof fauxProvider>;
  audit: { type: string; data: Record<string, any> }[];
  out: string[];
  err: string[];
  text: () => string;
}

interface RigOptions {
  failAuditAfter?: number;
  pages?: string[];
  docs?: ReturnType<typeof createDocStore>;
  statementTool?: boolean;
  fileListFirst?: boolean;
  workspace?: Workspace;
  filesEnabled?: boolean;
  chat?: boolean;
  /** The scripted model's context window and output cap (tokens). */
  window?: number;
  maxTokens?: number;
  serverContext?: (modelId: string) => Promise<number | undefined>;
  /** What happens to a figure that cannot be cited after the one repair (default: redact). */
  figureFallback?: "redact" | "warn";
  /** The read check (default 0: off, so the other tests are unchanged). */
  readMinPages?: number;
  /** The search-first part of the read check (default off, like the product). */
  readSearchFirst?: boolean;
}

function rig(opts: RigOptions = {}): Rig {
  const faux = fauxProvider(opts.window || opts.maxTokens ? { models: [{ id: "fake", ...(opts.window ? { contextWindow: opts.window } : {}), ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}) }] } : {});
  const models = createModels({ identity: { attribution: null } });
  models.setProvider(faux.provider);
  const audit: Rig["audit"] = [];
  const out: string[] = [];
  const err: string[] = [];
  const cfg = loadConfig({});
  const engine = createEngine({
    io: { write: (t) => void out.push(t), error: (l) => void err.push(l) },
    provider: "ollama",
    model: faux.getModel(),
    modelId: "fake",
    reasoning: reasoningProfile("ollama", undefined, "fake"),
    streamFn: (m, c, o) => models.streamSimple(m, c, o),
    workspace: opts.workspace ?? ws,
    audit: {
      write(type, data) {
        if (opts.failAuditAfter !== undefined && audit.length >= opts.failAuditAfter) throw new Error("disk full");
        audit.push({ type, data: (data ?? {}) as Record<string, any> });
      },
    },
    filesEnabled: opts.filesEnabled ?? true,
    calcShape: "expr",
    context: cfg.context,
    docs: opts.docs ?? createDocStore(ws, async (): Promise<ParsedPdf> => ({ pages: opts.pages ?? [PAGE] })),
    ...(opts.statementTool === undefined ? {} : { statementTool: opts.statementTool }),
    ...(opts.fileListFirst === undefined ? {} : { fileListFirst: opts.fileListFirst }),
    chat: opts.chat ?? false,
    links: false,
    ...(opts.serverContext ? { serverContext: opts.serverContext } : {}),
    ...(opts.figureFallback ? { figureFallback: opts.figureFallback } : {}),
    ...(opts.readMinPages ? { readMinPages: opts.readMinPages } : {}),
    ...(opts.readSearchFirst ? { readSearchFirst: true } : {}),
  });
  return { engine, faux, audit, out, err, text: () => out.join("") };
}
const types = (r: Rig) => r.audit.map((a) => a.type);
const find = (r: Rig, type: string) => r.audit.filter((a) => a.type === type);
const read = fauxToolCall("read_page", { path: "a.pdf", page: 1 }, { id: "t1" });

test("a read, a calculation and an answer: marks, references, checks and the audit trail", async () => {
  const r = rig();
  r.faux.setResponses([
    fauxAssistantMessage([read], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("calculate", { inputs: { a: "32,765", b: "31,009" }, expr: "(a - b) / b", dp: 1, pct: true }, { id: "t2" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Net sales were 32,765 in 2022, up 5.7%."),
  ]);
  const ok = await r.engine.ask("What were net sales in 2022, and the change from 2021?");
  assert.equal(ok, true);
  assert.deepEqual(r.err, []);
  assert.match(r.text(), /read page 1 of a.pdf/); // the dim tool-call line
  assert.match(r.text(), /Net sales were 32,765/);
  assert.match(r.text(), /\[1\]/); // the figure read from the page carries a reference mark
  const t = types(r);
  assert.equal(t[0], "session_start");
  for (const want of ["run_start", "tool_start", "tool_end", "message", "answer_shape", "provenance", "sources", "run_end"]) assert.ok(t.includes(want), `missing ${want}`);
  assert.equal(find(r, "tool_start").length, 2);
  assert.equal(find(r, "run_end")[0].data.outcome, "ok");
  assert.equal(find(r, "provenance")[0].data.unverified.length, 0);
  assert.ok(find(r, "sources")[0].data.entries.length >= 1);
  assert.equal(find(r, "period_units").length, 0); // the named year is the column the figure sits under
});

test("FIGURE_FALLBACK=warn: an answer that still has an uncited figure after the one repair is shown with a warning line", async () => {
  const r = rig({ figureFallback: "warn" });
  r.faux.setResponses([fauxAssistantMessage([read], { stopReason: "toolUse" }), fauxAssistantMessage("Net sales were 99,999."), fauxAssistantMessage("Net sales were 99,999 in 2022.")]);
  assert.equal(await r.engine.ask("What were net sales in 2022?"), true);
  assert.match(r.text(), /Net sales were 99,999 in 2022\./);
  assert.match(r.text(), /\[check\] 1 figure not traced/);
  assert.equal(find(r, "provenance")[0].data.unverified.length, 1);
  assert.deepEqual(find(r, "gate_decision").map((d) => [d.data.stage, d.data.figures]), [["first", 1], ["repaired", 1]]);
});

test("a figure printed under another year than the question names is logged, never shown", async () => {
  const r = rig();
  r.faux.setResponses([fauxAssistantMessage([read], { stopReason: "toolUse" }), fauxAssistantMessage("Net sales were 31,009.")]);
  await r.engine.ask("What were net sales in 2022?");
  const found = find(r, "period_units")[0]?.data.findings;
  assert.equal(found?.length, 1);
  assert.match(found[0].detail, /31,009 is printed under the 2021 column; the question names 2022/);
  assert.doesNotMatch(r.text(), /printed under the 2021 column/);
});

test("a reply with no answer is retried once, then the answer is shown", async () => {
  const r = rig();
  r.faux.setResponses([fauxAssistantMessage([]), fauxAssistantMessage("Hello there.")]);
  assert.equal(await r.engine.ask("hi"), true);
  assert.equal(find(r, "repair").length, 1);
  assert.match(r.text(), /\[repair\] the model returned an empty reply/);
  assert.match(r.text(), /Hello there\./);
  assert.equal(r.faux.state.callCount, 2);
});

test("a reply with no answer twice ends with a note, not a loop", async () => {
  const r = rig();
  r.faux.setResponses([fauxAssistantMessage([]), fauxAssistantMessage([])]);
  await r.engine.ask("hi");
  assert.equal(find(r, "repair_failed").length, 1);
  assert.equal(r.faux.state.callCount, 2); // one retry only
  assert.match(r.text(), /the model returned no answer/);
});

test("a call that repeats an earlier one is not run: the model is told, the budget is not spent, the audit says so", async () => {
  const r = rig();
  let seen = "";
  r.faux.setResponses([
    fauxAssistantMessage([read], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("read_page", { path: "a.pdf", page: 1 }, { id: "t9" })], { stopReason: "toolUse" }),
    (context) => {
      seen = JSON.stringify(context.messages);
      return fauxAssistantMessage("Net sales were 32,765.");
    },
  ]);
  const ok = await r.engine.ask("What were net sales in 2022?");
  assert.equal(ok, true);
  assert.match(seen, /same call as one already made/);
  assert.deepEqual(find(r, "guard").filter((g) => g.data.kind === "repeat").map((g) => g.data.free), [true]);
  assert.equal(find(r, "guard").filter((g) => g.data.kind === "call").length, 1); // only the first read counted
  assert.notEqual(find(r, "run_end")[0].data.outcome, "guard_tripped");
  assert.equal(find(r, "budget_note").length, 0);
});

test("a model that never stops calling tools is stopped by the guard", async () => {
  const r = rig();
  const call = (i: number) => fauxAssistantMessage([fauxToolCall("list_files", { path: "." }, { id: `c${i}` })], { stopReason: "toolUse" });
  r.faux.setResponses(Array.from({ length: 40 }, (_, i) => call(i)));
  const ok = await r.engine.ask("list everything forever");
  assert.equal(ok, false);
  assert.equal(find(r, "run_end")[0].data.outcome, "guard_tripped");
  assert.ok(find(r, "guard").length >= 1);
  assert.ok(r.err.join("\n").length > 0);
  assert.ok(r.faux.state.callCount < 40);
});

test("a model error is reported once and the question ends in error", async () => {
  const r = rig();
  r.faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "model exploded" })]);
  assert.equal(await r.engine.ask("hi"), false);
  assert.equal(find(r, "run_end")[0].data.outcome, "error");
  assert.match(r.err.join("\n"), /Error:/);
});

test("the audit log fails closed: after a write error nothing more runs", async () => {
  const r = rig({ failAuditAfter: 3 });
  r.faux.setResponses([fauxAssistantMessage("fine"), fauxAssistantMessage("never asked")]);
  assert.equal(await r.engine.ask("hi"), false);
  assert.match(r.engine.auditError() ?? "", /disk full/);
  assert.match(r.err.join("\n"), /Audit log write failed/);
  assert.equal(r.faux.state.callCount, 1); // the second reply was never requested
});

test("/new clears the ledger, /context shows or changes the level, /model switch is recorded", async () => {
  const r = rig();
  r.faux.setResponses([fauxAssistantMessage([read], { stopReason: "toolUse" }), fauxAssistantMessage("Net sales were 32,765.")]);
  await r.engine.ask("What were net sales in 2022?");
  assert.ok(r.engine.ledger.findAll(createNum("32,765")).length > 0);
  r.engine.newConversation();
  assert.equal(r.engine.ledger.findAll(createNum("32,765")).length, 0);
  assert.deepEqual(r.engine.agent.state.messages.filter((m: any) => m.role !== "system"), []);
  assert.ok(types(r).includes("session_reset"));

  r.out.length = 0;
  r.engine.contextCommand("strict");
  assert.equal(find(r, "context_level")[0].data.to, "strict");
  r.engine.contextCommand("nonsense");
  assert.match(r.text(), /Unknown level/);

  r.engine.useModel(r.faux.getModel(), "other", reasoningProfile("ollama", undefined, "other"));
  assert.equal(find(r, "model_switch")[0].data.to, "other");
});


test("the structured content of a read reaches the host but never the model", async () => {
  const r = rig();
  let seen = "";
  let host: any;
  r.engine.agent.subscribe((e) => {
    if (e.type === "tool_execution_end") host = e.result.structuredContent;
  });
  r.faux.setResponses([
    fauxAssistantMessage([read], { stopReason: "toolUse" }),
    (context) => {
      seen = JSON.stringify(context.messages);
      return fauxAssistantMessage("Net sales were 32,765.");
    },
  ]);
  await r.engine.ask("What were net sales in 2022?");
  assert.match(seen, /Net sales/); // the page text is there
  assert.doesNotMatch(seen, /pageLines|structuredContent|lineOffset/); // the host's side data is not
  assert.equal(host.shown[0].meta.page, 1); // the host did get it
});

test("a guard cut of a long result keeps the structured content", async () => {
  const { createGuard } = await import("../src/guard.ts");
  const guard = createGuard({ maxCallsPerRun: 8, maxOutputChars: 10, maxTotalChars: 1000, log: () => {} });
  const structured = { shown: [{ label: "x", text: "y", meta: { file: "x" } }] };
  const after = await guard.afterToolCall({ toolCall: { name: "read_page" }, result: { content: [{ type: "text", text: "z".repeat(50) }], details: {}, structuredContent: structured } } as never);
  assert.match((after?.content?.[0] as { text: string }).text, /output truncated/);
  assert.deepEqual(after?.structuredContent, structured);
});

test("a read and a calculation in one reply: the ledger is fed before the calculation is checked", async () => {
  const r = rig();
  let calcText = "";
  r.faux.setResponses([
    fauxAssistantMessage([read, fauxToolCall("calculate", { inputs: { a: "32,765", b: "31,009" }, expr: "(a - b) / b", dp: 1, pct: true }, { id: "t2" })], { stopReason: "toolUse" }),
    (context) => {
      calcText = JSON.stringify(context.messages.filter((m: any) => m.role === "toolResult" && m.toolName === "calculate"));
      return fauxAssistantMessage("Net sales rose 5.7%.");
    },
  ]);
  await r.engine.ask("What was the change in net sales from 2021 to 2022?");
  assert.match(calcText, /5\.7%/);
  assert.doesNotMatch(calcText, /not found in the file text/);
});

test("a read of the whole page and of a passage both feed the ledger (read_file too)", async () => {
  fs.writeFileSync(path.join(base, "ws", "n.txt"), "Revenue was 777 in the year.");
  const r = rig();
  r.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("read_page", { path: "a.pdf", page: 1, find: "net income" }, { id: "p" }), fauxToolCall("read_file", { path: "n.txt" }, { id: "f" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Net income was 5,921 and revenue 777."),
  ]);
  await r.engine.ask("net income and revenue?");
  assert.equal(find(r, "provenance")[0].data.unverified.length, 0);
});

test("stop() ends an answer in progress as aborted; it does nothing when idle", async () => {
  const r = rig();
  assert.equal(r.engine.stop(), false);
  r.faux.setResponses([(() => { r.engine.stop(); return fauxAssistantMessage("late"); }) as never]);
  await r.engine.ask("hi");
  assert.equal(find(r, "run_end")[0].data.outcome, "aborted");
});

test("get_line_item: the structured row is traced, referenced and counted like a page read; the prompt tells the model to call it first", async () => {
  const r = rig({ pages: D.REAL_10K, statementTool: true });
  r.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("get_line_item", { path: "a.pdf", concept: "total_assets", period: "2022" }, { id: "g1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Total assets were 5,600 at the end of 2022."),
  ]);
  assert.equal(await r.engine.ask("What were total assets at the end of 2022?"), true);
  assert.deepEqual(r.err, []);
  assert.match(r.text(), /\[1\]/); // the figure carries a reference mark
  assert.equal(find(r, "provenance")[0].data.unverified.length, 0);
  assert.ok(find(r, "sources")[0].data.entries.length >= 1);
  const start = find(r, "session_start")[0].data;
  assert.ok(start.tools.includes("get_line_item"));
  assert.match(start.systemPrompt, /call get_line_item first/);
  assert.equal(find(r, "period_units").length, 0);
});

test("get_line_item: it is off unless asked for: no tool and no prompt sentence", async () => {
  const r = rig();
  const start = find(r, "session_start")[0].data;
  assert.ok(!start.tools.includes("get_line_item"));
  assert.doesNotMatch(start.systemPrompt, /get_line_item/);
});

const seenFirst = (r: Rig) => {
  const box = { text: "" };
  r.faux.setResponses([
    (context) => {
      box.text = JSON.stringify(context.messages.filter((m: any) => m.role === "user"));
      return fauxAssistantMessage("ok");
    },
  ]);
  return box;
};

const COVER_PAGE = "UNITED STATES\nSECURITIES AND EXCHANGE COMMISSION\nFORM 10-K\nANNUAL REPORT PURSUANT TO SECTION 13 OR 15(d) OF THE SECURITIES EXCHANGE ACT OF 1934\nFor the fiscal year ended January 28, 2023\nCommission file number 1-1234\nACME CORP\n(Exact name of registrant as specified in its charter)\nDelaware | 12-3456789\n(State or other jurisdiction of | (I.R.S. Employer";

test("the file list in the first message says which filing each PDF is; the audit counts them; /files shows the same to the user", async () => {
  const r = rig({ pages: [COVER_PAGE] });
  const first = seenFirst(r);
  await r.engine.ask("What were net sales?");
  assert.match(first.text, /a\.pdf {2}\(4 B\) {2}— {2}ACME CORP · 10-K · FY ended January 28, 2023/);
  assert.match(first.text, /read from each PDF's cover/);
  assert.equal(find(r, "file_listing")[0].data.identified, 1);

  const before = r.out.length;
  await r.engine.filesCommand();
  const shown = r.out.slice(before).join("");
  assert.match(shown, /\[2 files in the workspace\]/);
  assert.match(shown, /a\.pdf {2}\(4 B\) {2}— {2}ACME CORP · 10-K · FY ended January 28, 2023/);
  assert.deepEqual(find(r, "files_command").map((a) => a.data), [{ count: 2, identified: 1 }]);

  const off = rig({ filesEnabled: false });
  await off.engine.filesCommand();
  assert.match(off.text(), /File access is off/);
  assert.equal(find(off, "files_command").length, 0);
});

test("Ctrl+C while the covers are being read stops the question before the model is asked; the next question still carries the list", async () => {
  let looks = 0;
  const hang = createDocStore(ws, undefined, (_b, signal) => (++looks > 1 ? Promise.resolve({ pages: [PAGE] }) : new Promise<ParsedPdf>((_, reject) => signal?.addEventListener("abort", () => reject(new PdfError("aborted", "cancelled"))))));
  const r = rig({ docs: hang });
  let asked = 0;
  r.faux.setResponses([() => (asked++, fauxAssistantMessage("ok"))]);
  const q = r.engine.ask("What were net sales?");
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(r.engine.stop(), true); // the look is running: Ctrl+C is taken
  await q;
  assert.equal(asked, 0); // the model was never asked
  assert.equal(find(r, "run_end")[0].data.outcome, "aborted");
  assert.equal(find(r, "file_listing").length, 0);
  assert.equal(r.engine.stop(), false); // nothing is running any more
  const next = seenFirst(r);
  await r.engine.ask("Again?");
  assert.match(next.text, /Files in the workspace/); // the list was not used up
});

test("the first question of a conversation carries the small workspace's file list; later ones and the checks do not", async () => {
  const r = rig();
  const first = seenFirst(r);
  await r.engine.ask("What were net sales in 2022?");
  assert.match(first.text, /What were net sales in 2022\?/);
  assert.match(first.text, /Files in the workspace, listed by the harness/);
  assert.match(first.text, /\[2 files in the workspace\]/); // a.pdf and a text file another test wrote
  assert.match(first.text, /a\.pdf {2}\(4 B\)/);
  assert.equal(find(r, "file_listing").length, 1);
  assert.equal(find(r, "file_listing")[0].data.count, 2);
  assert.equal(find(r, "run_start")[0].data.text, "What were net sales in 2022?"); // the audit keeps the user's own words
  // second question in the same conversation: no list
  const second = seenFirst(r);
  await r.engine.ask("And net income?");
  assert.doesNotMatch(second.text.split("And net income?")[1] ?? "", /Files in the workspace/);
  assert.equal(find(r, "file_listing").length, 1);
  // a new conversation lists again
  r.engine.newConversation();
  const third = seenFirst(r);
  await r.engine.ask("Again?");
  assert.match(third.text, /Files in the workspace/);
  assert.equal(find(r, "file_listing").length, 2);
});

test("the file list is left out when the switch is off, when the workspace is large or empty", async () => {
  const off = rig({ fileListFirst: false });
  const a = seenFirst(off);
  await off.engine.ask("Q?");
  assert.doesNotMatch(a.text, /Files in the workspace/);
  const big = path.join(base, "big");
  fs.mkdirSync(big);
  for (let i = 0; i < 21; i++) fs.writeFileSync(path.join(big, `f${i}.pdf`), "x");
  const bigRig = rig({ workspace: openWorkspace(big, path.join(base, "project"), []) });
  const b = seenFirst(bigRig);
  await bigRig.engine.ask("Q?");
  assert.doesNotMatch(b.text, /Files in the workspace/);
  assert.equal(find(bigRig, "file_listing").length, 0);
  const none = path.join(base, "none");
  fs.mkdirSync(none);
  const emptyRig = rig({ workspace: openWorkspace(none, path.join(base, "project"), []) });
  const e = seenFirst(emptyRig);
  await emptyRig.engine.ask("Q?");
  assert.doesNotMatch(e.text, /Files in the workspace/);
});

test("each assistant reply is recorded with its timing and character counts", async () => {
  const r = rig();
  r.faux.setResponses([fauxAssistantMessage([read], { stopReason: "toolUse" }), fauxAssistantMessage("Net sales were 32,765.")]);
  await r.engine.ask("What were net sales in 2022?");
  const replies = find(r, "message").filter((m) => m.data.message.role === "assistant");
  assert.equal(replies.length, 2);
  for (const m of replies) {
    const t = m.data.timing;
    assert.equal(typeof t.totalMs, "number");
    assert.ok(t.totalMs >= 0);
    assert.ok(t.ttftMs === null || t.ttftMs <= t.totalMs);
    for (const k of ["thinkingChars", "textChars", "callChars"]) assert.equal(typeof t[k], "number");
  }
  assert.ok(replies[0].data.timing.callChars > 0); // the tool call
  assert.equal(replies[1].data.timing.textChars, "Net sales were 32,765.".length);
  assert.equal(find(r, "message").find((m) => m.data.message.role === "toolResult")!.data.timing, undefined); // only replies carry timing
});

test("a prompt near the window gives the context warning once, and the meter with the /new hint in chat", async () => {
  const r = rig({ window: 1000, chat: true });
  r.faux.setResponses([fauxAssistantMessage("Fine.")]);
  await r.engine.ask("pad ".repeat(850));
  assert.match(r.text(), /\[context\] this step's prompt used \d+ of 1000 tokens/);
  assert.equal(find(r, "context_warning").length, 1);
  assert.match(r.text(), /context \d+%: near the limit; \/new starts a fresh conversation/);
  assert.doesNotMatch(r.text(), /\n\n\n/); // the notes and footer lines never leave two blank lines in a row
});

test("the meter is plain and has no /new hint in a one-off question", async () => {
  const r = rig({ window: 100000, chat: false });
  r.faux.setResponses([fauxAssistantMessage("Fine.")]);
  await r.engine.ask("hi");
  assert.match(r.text(), /context \d+%/);
  assert.doesNotMatch(r.text(), /\/new/);
  assert.equal(find(r, "context_warning").length, 0);
});

test("the server's window is checked once per model; a different one is warned about, recorded and used", async () => {
  let asked = 0;
  const r = rig({
    serverContext: async () => {
      asked++;
      return 4096;
    },
  });
  r.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
  await r.engine.ask("hi");
  assert.match(r.text(), /Ollama is running fake with a 4096-token window/);
  assert.deepEqual([find(r, "context_mismatch")[0].data.actual, r.engine.agent.state.model.contextWindow], [4096, 4096]);
  await r.engine.ask("again");
  assert.equal(asked, 1); // not asked again for the same model
  r.engine.useModel(r.faux.getModel(), "other", reasoningProfile("ollama", undefined, "other"));
  await r.engine.ask("and again");
  assert.equal(asked, 2); // a model switch asks again
});

test("a runaway reply is cut off while it streams and the question is retried once", async () => {
  const r = rig({ maxTokens: 50 }); // 50 tokens: a reply over 300 characters is a runaway
  r.faux.setResponses([fauxAssistantMessage("x".repeat(1000)), fauxAssistantMessage("Done.")]);
  assert.equal(await r.engine.ask("hi"), true);
  assert.equal(find(r, "runaway").length, 1);
  assert.equal(find(r, "runaway_retry").length, 1);
  assert.match(r.text(), /\[stopped\] one reply longer than 300 characters/);
  assert.ok(r.text().indexOf("xxxxxxxxxx") >= 0 && r.text().indexOf("xxxxxxxxxx") < r.text().indexOf("[stopped]")); // the text that looped comes first, then the stop line
  assert.match(r.text(), /\[repair\] the model got stuck in a loop/);
  assert.match(r.text(), /Done\./);
  assert.equal(r.faux.state.callCount, 2);
  assert.doesNotMatch(r.text(), /\n\n\n/);
});

test("the runaway cap follows the model chosen with /model", async () => {
  const r = rig({ maxTokens: 50 });
  r.engine.useModel({ ...r.faux.getModel(), maxTokens: 16384 }, "big", reasoningProfile("ollama", undefined, "big"));
  r.faux.setResponses([fauxAssistantMessage("x".repeat(1000))]);
  assert.equal(await r.engine.ask("hi"), true);
  assert.equal(find(r, "runaway").length, 0);
  assert.equal(r.faux.state.callCount, 1);
});

test("a spent file-reading budget refuses further reads (soft stop) and the answer carries a note", async () => {
  const page = (n: number) => ["Consolidated Statements of Income", "(in millions)", "Year ended December 31  |  2022  |  2021", ...Array.from({ length: 80 }, (_, i) => `Row ${n}-${i} filler text for the page  |  ${i + 1}  |  ${i + 2}`)].join("\n");
  const r = rig({ pages: [1, 2, 3, 4, 5, 6, 7].map(page) }); // about 3,800 characters each: the 20,000-character budget is spent after six
  let last = "";
  r.faux.setResponses([
    ...[1, 2, 3, 4, 5, 6, 7].map((n) => fauxAssistantMessage([fauxToolCall("read_page", { path: "a.pdf", page: n }, { id: `r${n}` })], { stopReason: "toolUse" })),
    (context) => {
      last = JSON.stringify(context.messages.filter((m: any) => m.role === "toolResult").at(-1));
      return fauxAssistantMessage("I could not read more.");
    },
  ]);
  assert.equal(await r.engine.ask("Summarise the filing."), true);
  assert.ok(find(r, "guard").some((g) => g.data.kind === "blocked"));
  assert.match(last, /No more tool calls are available/);
  assert.equal(find(r, "budget_note").length, 1);
  assert.equal(find(r, "run_end")[0].data.outcome, "ok");
});

test("without file access there is no file tool and no file list", async () => {
  const r = rig({ filesEnabled: false });
  r.faux.setResponses([fauxAssistantMessage("Hello.")]);
  await r.engine.ask("hi");
  const start = find(r, "session_start")[0].data;
  assert.deepEqual(start.tools, ["calculate"]);
  assert.equal(start.filesEnabled, false);
  assert.equal(start.sampling, null); // the scripted model has no sampling settings: the model's own defaults
  assert.equal(find(r, "file_listing").length, 0);
});

test("a reply with thinking shows a thinking line on its own line and records the thinking size", async () => {
  const r = rig();
  r.faux.setResponses([fauxAssistantMessage([fauxThinking("let me see"), fauxText("Done.")])]);
  await r.engine.ask("hi");
  assert.match(r.text(), /thinking…\S*\n\S*writing…\S*\nDone\./); // the answer is held until the reply ends; a status line stands in
  assert.equal(find(r, "message").find((m) => m.data.message.role === "assistant")!.data.timing.thinkingChars, "let me see".length);
});

// ---- holding replies: only an answer is shown; a draft in a tool-call reply stays in the audit log -------------------------

test("text written in a reply that ends in a tool call is never shown; the answer is printed whole when its reply ends", async () => {
  const r = rig();
  r.faux.setResponses([
    fauxAssistantMessage([fauxText("Draft: net sales were 99,999."), read], { stopReason: "toolUse" }),
    fauxAssistantMessage("Net sales were 32,765 in 2022."),
  ]);
  assert.equal(await r.engine.ask("What were net sales in 2022?"), true);
  assert.doesNotMatch(r.text(), /Draft: net sales were 99,999/);
  assert.match(r.text(), /Net sales were 32,765.*\[1\].* in 2022\./); // the mark belongs to the answer's figure, not to the draft's
  assert.doesNotMatch(r.text(), /\[check\].*not traced/); // the draft's figure was never shown, so it is not reported
  const replies = find(r, "message").filter((m) => m.data.message.role === "assistant");
  assert.ok(JSON.stringify(replies[0].data.message).includes("Draft: net sales were 99,999")); // the audit log keeps the draft
  assert.deepEqual(find(r, "reply_disposition").map((d) => d.data.kind), ["working", "answer"]);
  assert.equal(find(r, "provenance")[0].data.unverified.length, 1); // all assistant text, as before
  assert.equal(find(r, "figure_gate")[0].data.untraced.length, 0); // only the answer that was shown
});

test("one writing line per reply, then the whole answer", async () => {
  const r = rig();
  r.faux.setResponses([fauxAssistantMessage("Hello there.")]);
  await r.engine.ask("hi");
  assert.equal((r.text().match(/writing…/g) ?? []).length, 1);
  assert.match(r.text(), /writing…\S*\nHello there\./);
});

test("an answer that ends at the output cap is printed", async () => {
  const r = rig();
  r.faux.setResponses([fauxAssistantMessage([read], { stopReason: "toolUse" }), fauxAssistantMessage("Net sales were 32,765.", { stopReason: "length" })]);
  await r.engine.ask("hi");
  assert.match(r.text(), /Net sales were 32,765/);
});

test("a reply cut off by an error is printed as it is, even when it had a tool call", async () => {
  const r = rig();
  r.faux.setResponses([fauxAssistantMessage([fauxText("half an answ"), read], { stopReason: "error", errorMessage: "boom" })]);
  assert.equal(await r.engine.ask("hi"), false);
  assert.match(r.text(), /half an answ/);
  assert.match(r.text(), /\[the answer is incomplete\]/);
});

test("a hard stop with text only in the last tool-call reply still shows that text once, with one incomplete note", async () => {
  const r = rig();
  const call = (i: number) => fauxAssistantMessage([fauxText(`step ${"abcdefghijklmnopqrstuvwxyz"[i % 26]}`), fauxToolCall("list_files", { path: "." }, { id: `c${i}` })], { stopReason: "toolUse" });
  r.faux.setResponses(Array.from({ length: 40 }, (_, i) => call(i)));
  assert.equal(await r.engine.ask("list everything forever"), false);
  assert.equal((r.text().match(/step [a-z]\b/g) ?? []).length, 1);
  assert.equal((r.text().match(/\[the answer is incomplete\]/g) ?? []).length, 1);
});

test("reasoning shown as a last resort is not followed by an earlier draft", async () => {
  const r = rig();
  r.faux.setResponses([
    fauxAssistantMessage([fauxText("my draft"), read], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxThinking("first reasoning")]),
    fauxAssistantMessage([fauxThinking("second reasoning")]),
  ]);
  await r.engine.ask("hi");
  assert.match(r.text(), /second reasoning/);
  assert.doesNotMatch(r.text(), /my draft/);
});

test("a new question starts with nothing held: drafts of an earlier question are never shown", async () => {
  const r = rig({ chat: true });
  r.faux.setResponses([
    fauxAssistantMessage([fauxText("draft one"), read], { stopReason: "toolUse" }),
    fauxAssistantMessage("Answer one."),
    fauxAssistantMessage([fauxText("draft two"), fauxToolCall("list_files", { path: "." }, { id: "t9" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Answer two."),
  ]);
  await r.engine.ask("first?");
  await r.engine.ask("second?");
  assert.doesNotMatch(r.text(), /draft (one|two)/);
  assert.match(r.text(), /Answer one\.[^]*Answer two\./);
});

test("the system prompt tells the model how the harness tells figures from labels", () => {
  const r = rig();
  const prompt = find(r, "session_start")[0].data.systemPrompt as string;
  assert.match(prompt, /checks every figure you write/);
  assert.match(prompt, /COVID-19, Rule 10b-5, ASC 606, 30-day\) are labels, not figures/);
});

test("the engine records a calculation in the ledger before the next call: a later step may use it, the answer may quote it", async () => {
  const r = rig();
  let secondResult = "";
  r.faux.setResponses([
    fauxAssistantMessage([read], { stopReason: "toolUse" }),
    fauxAssistantMessage(
      [
        fauxToolCall("calculate", { inputs: { a: "32,765", b: "31,009" }, expr: "(a - b) / b", dp: 1, pct: true }, { id: "c1" }),
        fauxToolCall("calculate", { inputs: { g: "5.7%" }, expr: "g * 2", dp: 1, pct: true }, { id: "c2" }),
      ],
      { stopReason: "toolUse" },
    ),
    (context) => {
      secondResult = JSON.stringify(context.messages.filter((m: any) => m.role === "toolResult" && m.toolCallId === "c2"));
      return fauxAssistantMessage("Net sales rose 5.7%, and twice that is 11.4%.");
    },
  ]);
  await r.engine.ask("What was the change in net sales from 2021 to 2022?");
  assert.match(secondResult, /"toolCallId":"c2"/); // the second result was captured
  assert.doesNotMatch(secondResult, /was not found in the file text/); // 5.7% came from the first calculation
  assert.equal(find(r, "provenance")[0].data.unverified.length, 0);
  assert.ok(find(r, "provenance")[0].data.counts.C >= 2);
  assert.equal(find(r, "ledger_feed_error").length, 0);
});

// ---- citations: a calculated figure shows its formula, its printed operands and the rows they came from -------------------

const calcCall = (inputs: Record<string, string>, expr: string, extra: Record<string, unknown> = {}, id = "t2") => fauxAssistantMessage([fauxToolCall("calculate", { inputs, expr, ...extra }, { id })], { stopReason: "toolUse" });

test("a calculated figure carries a mark, and its entry shows the formula and the entry of its operands", async () => {
  const r = rig();
  r.faux.setResponses([fauxAssistantMessage([read], { stopReason: "toolUse" }), calcCall({ a: "32,765", b: "31,009" }, "(a - b) / b", { dp: 1, pct: true }), fauxAssistantMessage("Net sales rose 5.7% in 2022.")]);
  assert.equal(await r.engine.ask("What was the change in net sales in 2022?"), true);
  assert.match(r.text(), /Net sales rose 5\.7%.*\[1\].* in 2022\./);
  assert.match(r.text(), /\[1\]  5\.7% = \(32,765 - 31,009\) \/ 31,009   inputs from \[2\]/);
  assert.match(r.text(), /\[2\]  a\.pdf  p\.1/);
  assert.match(r.text(), /Figures are matched by value on the page: check the row and column\./);
  const c = find(r, "citations")[0].data.figures[0];
  assert.deepEqual([c.figure, c.kind, c.marks, c.step], ["5.7%", "calc", [1], "result"]);
  assert.deepEqual(c.operands.map((o: any) => [o.name, o.how, o.page]), [["a", "page", 1], ["b", "page", 1]]);
});

test("a calculation with an operand that was never printed, or a number the model converted itself, gets no mark", async () => {
  const r = rig({ figureFallback: "warn" });
  r.faux.setResponses([fauxAssistantMessage([read], { stopReason: "toolUse" }), calcCall({ a: "32,765", b: "30,000" }, "(a - b) / b", { dp: 1, pct: true }), fauxAssistantMessage("Net sales rose 9.2% in 2022."), fauxAssistantMessage("Net sales rose 9.2% in 2022.")]);
  await r.engine.ask("What was the change in net sales in 2022?");
  assert.doesNotMatch(r.text(), /9\.2%.*\[\d\]/);
  const c = find(r, "citations")[0].data.figures.find((f: any) => f.figure === "9.2%");
  assert.equal(c.kind, "uncited");
  assert.match(c.reason, /30,000/);
  const r2 = rig({ figureFallback: "warn" });
  r2.faux.setResponses([fauxAssistantMessage([read], { stopReason: "toolUse" }), calcCall({ a: "32,765" }, "a * 0.41", { dp: 1 }), fauxAssistantMessage("It is 13,433.7."), fauxAssistantMessage("It is 13,433.7.")]);
  await r2.engine.ask("What is 41% of net sales in 2022?");
  assert.equal(find(r2, "citations")[0].data.figures.find((f: any) => f.figure === "13,433.7").kind, "uncited"); // 0.41 is the model's own conversion of 41%
});

test("two questions in one chat keep separate calculation entries: the same step name is two calculations", async () => {
  const r = rig({ chat: true });
  r.faux.setResponses([
    fauxAssistantMessage([read], { stopReason: "toolUse" }),
    calcCall({ a: "32,765", b: "31,009" }, "a - b", {}, "c1"),
    fauxAssistantMessage("The increase was 1,756."),
    calcCall({ a: "5,921", b: "5,100" }, "a - b", {}, "c2"),
    fauxAssistantMessage("Net income rose by 821."),
  ]);
  await r.engine.ask("What was the increase in net sales?");
  await r.engine.ask("And in net income?");
  const calls = find(r, "citations").map((c) => c.data.figures.find((f: any) => f.kind === "calc").call);
  assert.deepEqual(calls, [1, 2]);
  assert.match(r.text(), /\[1\]  821 = 5,921 - 5,100/);
});

test("a quote whose scale word contradicts the page's unit is not marked", async () => {
  const r = rig({ figureFallback: "warn" });
  r.faux.setResponses([fauxAssistantMessage([read], { stopReason: "toolUse" }), fauxAssistantMessage("Net sales were $32,765 billion in 2022."), fauxAssistantMessage("Net sales were $32,765 billion in 2022.")]);
  await r.engine.ask("What were net sales in 2022?");
  assert.doesNotMatch(r.text(), /32,765 billion.*\[\d\]/);
  assert.match(find(r, "citations")[0].data.figures[0].reason, /another unit/);
});

test("the same value on two rows: the row named in the sentence is the one cited", async () => {
  const pages = [["Statements", "(in millions)", "Year ended December 31  |  2022  |  2021", "Net sales  |  5,000  |  4,000", "Total assets  |  5,000  |  4,500"].join("\n")];
  const r = rig({ pages });
  r.faux.setResponses([fauxAssistantMessage([read], { stopReason: "toolUse" }), fauxAssistantMessage("Total assets were 5,000 in 2022.")]);
  await r.engine.ask("What were total assets in 2022?");
  assert.match(r.text(), /Total assets +\[5,000\]/);
  assert.doesNotMatch(r.text(), /Net sales +\[5,000\]/);
});


// ---- the figure gate: an answer is checked before it is shown; one repair; what still cannot be cited is left out --------------

test("the gate: a draft with an uncited figure is never shown; one repair message names it; the repaired answer is shown with its calculation", async () => {
  const r = rig();
  r.faux.setResponses([
    fauxAssistantMessage([read], { stopReason: "toolUse" }),
    fauxAssistantMessage("Net sales rose 5.6% in 2022."), // the model's own arithmetic
    calcCall({ a: "32,765", b: "31,009" }, "(a - b) / b", { dp: 1, pct: true }, "t3"),
    fauxAssistantMessage("Net sales rose 5.7% in 2022."),
  ]);
  assert.equal(await r.engine.ask("What was the change in net sales in 2022?"), true);
  assert.doesNotMatch(r.text(), /5\.6%/); // the draft is never shown
  assert.match(r.text(), /Net sales rose 5\.7%.*\[1\].* in 2022\./);
  assert.match(r.text(), /\[1\]  5\.7% = \(32,765 - 31,009\) \/ 31,009/);
  assert.doesNotMatch(r.text(), /\[check\]/);
  assert.deepEqual(find(r, "gate_decision").map((d) => [d.data.stage, d.data.figures]), [["first", 1], ["repaired", 0]]);
  const repair = find(r, "gate_repair")[0].data;
  assert.match(repair.text, /"5\.6%" in: "Net sales rose 5\.6% in 2022\."/);
  assert.match(repair.text, /call calculate/);
  assert.ok(find(r, "message").some((m) => m.data.message.role === "user" && m.data.message.harness === "repair")); // the audit log holds the repair message
  const shown = find(r, "answer_shown")[0].data;
  assert.deepEqual([shown.repaired, shown.redacted, shown.withheld], [true, 0, false]);
  assert.match(shown.text, /5\.7%/);
  assert.equal(find(r, "run_end")[0].data.outcome, "ok");
  assert.equal(r.faux.state.callCount, 4);
});

test("the gate: a clean answer is shown at once, with no repair", async () => {
  const r = rig();
  r.faux.setResponses([fauxAssistantMessage([read], { stopReason: "toolUse" }), fauxAssistantMessage("Net sales were 32,765 in 2022.")]);
  await r.engine.ask("What were net sales in 2022?");
  assert.equal(find(r, "gate_repair").length, 0);
  assert.equal(r.faux.state.callCount, 2);
  assert.deepEqual(find(r, "gate_decision").map((d) => d.data.stage), ["first"]);
});

test("the gate: when the second try gives no answer, the repair leaves the conversation and the first answer is shown without its uncited sentence", async () => {
  const r = rig();
  r.faux.setResponses([
    fauxAssistantMessage([read], { stopReason: "toolUse" }),
    fauxAssistantMessage("Net sales were about 99,999 in 2022. Net sales in 2022 were 32,765 on the income statement."),
    fauxAssistantMessage([]), // the repair gets an empty reply
  ]);
  assert.equal(await r.engine.ask("What were net sales in 2022?"), true); // what went wrong in the second try is not the question's outcome
  assert.doesNotMatch(r.text(), /99,999/);
  assert.match(r.text(), /Net sales in 2022 were 32,765/);
  assert.match(r.text(), /Left out: a sentence with a figure that could not be traced/);
  assert.equal(find(r, "gate_repair_failed").length, 1);
  assert.equal(find(r, "run_end")[0].data.outcome, "ok");
  assert.ok(!(r.engine.agent.state.messages as any[]).some((m) => m.harness === "repair")); // the repair and its replies are gone
  const shown = find(r, "answer_shown")[0].data;
  assert.deepEqual([shown.repaired, shown.redacted, shown.withheld], [false, 1, false]);
  assert.doesNotMatch(shown.text, /99,999/); // the log says what the user saw, not the rejected draft
});

test("the gate: an answer whose figures all fail is withheld with one fixed line", async () => {
  const r = rig();
  r.faux.setResponses([fauxAssistantMessage([read], { stopReason: "toolUse" }), fauxAssistantMessage("Net sales were 99,999."), fauxAssistantMessage("Net sales were 99,999.")]);
  await r.engine.ask("What were net sales in 2022?");
  assert.doesNotMatch(r.text(), /99,999/);
  assert.match(r.text(), /The answer was withheld: its figures could not be traced to a page or the calculator\./);
  assert.equal(find(r, "answer_shown")[0].data.withheld, true);
});

test("the gate: while the reading budget is open the repair message offers to open another page", async () => {
  const r = rig();
  r.faux.setResponses([fauxAssistantMessage([read], { stopReason: "toolUse" }), fauxAssistantMessage("Net sales were 99,999."), fauxAssistantMessage("Net sales were 32,765 in 2022.")]);
  await r.engine.ask("What were net sales in 2022?");
  assert.match(find(r, "gate_repair")[0].data.text, /open that page/); // budget not spent: the clause is there
});

test("the gate: no repair after a stop by the user; the second try is quiet when it is cut off", async () => {
  const r = rig();
  r.faux.setResponses([fauxAssistantMessage([read], { stopReason: "toolUse" }), fauxAssistantMessage("Net sales were 99,999."), (() => { r.engine.stop(); return fauxAssistantMessage("late"); }) as never]);
  await r.engine.ask("What were net sales in 2022?");
  assert.equal(find(r, "run_end")[0].data.outcome, "aborted");
  assert.doesNotMatch(r.text(), /99,999/);
  assert.equal(find(r, "answer_shown").length, 0);
});

test("the gate: a partial reply and the reasoning fallback lose their uncited sentences too", async () => {
  const r = rig();
  r.faux.setResponses([fauxAssistantMessage([fauxText("Net sales were 99,999. More text follows."), read], { stopReason: "error", errorMessage: "boom" })]);
  await r.engine.ask("hi");
  assert.doesNotMatch(r.text(), /99,999/);
  assert.match(r.text(), /More text follows\./);
  const r2 = rig();
  r2.faux.setResponses([fauxAssistantMessage([fauxThinking("Net sales were 99,999.")]), fauxAssistantMessage([fauxThinking("Net sales were 99,999. Other words here.")])]);
  await r2.engine.ask("hi");
  assert.doesNotMatch(r2.text(), /99,999/);
});

test("the gate: the next question in a chat still has its first question and page text; the repair message belongs to the question it was sent in", async () => {
  const r = rig({ chat: true });
  r.faux.setResponses([
    fauxAssistantMessage([read], { stopReason: "toolUse" }),
    fauxAssistantMessage("Net sales rose 5.6% in 2022."),
    calcCall({ a: "32,765", b: "31,009" }, "(a - b) / b", { dp: 1, pct: true }, "t3"),
    fauxAssistantMessage("Net sales rose 5.7% in 2022."),
    fauxAssistantMessage("Net income was 5,921 in 2022."),
  ]);
  await r.engine.ask("What was the change in net sales in 2022?");
  await r.engine.ask("And net income?");
  const msgs = r.engine.agent.state.messages as any[];
  assert.equal(msgs.filter((m) => m.role === "user" && m.harness !== "repair").length, 2); // two questions, one tagged repair message between
  assert.equal(msgs.filter((m) => m.harness === "repair").length, 1);
});

// ---- the read check (src/readcheck.ts): READ_MIN_PAGES ----
const TOPIC_PAGES = [PAGE, "Business overview\nNet sales grew on pricing.", "Risk factors\nNet sales depend on currency.", "Outlook\nNet sales may change next year."];
const LONG_ONE = "The company reports higher net sales this year than last year, and the filing explains that growth came from several areas.\n* Pricing improved across most product lines during the year.\n* Volume rose in the largest region while a smaller region declined.\n* Currency effects reduced the reported total somewhat.\n* Management expects similar conditions to continue next year.";
const LONG_TWO = "The company reports higher net sales this year than last year; the pages explain why.\n* Pricing improved across most product lines during the year, which the overview page describes.\n* Currency effects reduced the reported total, as the risk page explains.\n* The outlook page says conditions may change next year, so the direction is uncertain for the company.";
const search = fauxToolCall("search", { path: "a.pdf", query: "net sales" }, { id: "s1" });
const readN = (n: number) => fauxToolCall("read_page", { path: "a.pdf", page: n }, { id: `r${n}` });

test("read check: a long answer built on one page gets one message naming the next listed pages, then the new answer is shown", async () => {
  const r = rig({ pages: TOPIC_PAGES, readMinPages: 3 });
  r.faux.setResponses([
    fauxAssistantMessage([search], { stopReason: "toolUse" }),
    fauxAssistantMessage([readN(1)], { stopReason: "toolUse" }),
    fauxAssistantMessage(LONG_ONE),
    () => {
      const last = (r.engine.agent.state.messages as any[]).filter((m) => m.role === "user").pop();
      assert.equal(last.harness, "repair"); // the nudge is the model's latest user message
      assert.match(last.content[0].text, /you looked at 1 page /);
      return fauxAssistantMessage([readN(2), readN(3)], { stopReason: "toolUse" });
    },
    fauxAssistantMessage(LONG_TWO),
  ]);
  assert.equal(await r.engine.ask("Why did net sales change?"), true);
  const nudge = find(r, "read_nudge");
  assert.equal(nudge.length, 1);
  assert.equal(nudge[0].data.looked, 1);
  assert.equal(nudge[0].data.pages.length, 2);
  const done = find(r, "read_nudge_done");
  assert.equal(done.length, 1);
  assert.equal(done[0].data.after, 3);
  assert.match(r.text(), /pages explain why/); // the second answer is what is shown
  assert.doesNotMatch(r.text(), /Management expects similar conditions/);
  assert.equal(find(r, "answer_shown")[0].data.readNudged, true);
  assert.equal(find(r, "answer_shown").length, 1);
});

test("read check: a short lookup answer is exempt, and so is an answer that already looked at enough pages", async () => {
  const r = rig({ pages: TOPIC_PAGES, readMinPages: 3 });
  r.faux.setResponses([fauxAssistantMessage([search], { stopReason: "toolUse" }), fauxAssistantMessage([readN(1)], { stopReason: "toolUse" }), fauxAssistantMessage("Net sales were 32,765 in 2022.")]);
  await r.engine.ask("What were net sales in 2022?");
  assert.equal(find(r, "read_nudge").length, 0);
  const r2 = rig({ pages: TOPIC_PAGES, readMinPages: 3 });
  r2.faux.setResponses([
    fauxAssistantMessage([search], { stopReason: "toolUse" }),
    fauxAssistantMessage([readN(1), readN(2), readN(3)], { stopReason: "toolUse" }),
    fauxAssistantMessage(LONG_ONE),
  ]);
  await r2.engine.ask("Why did net sales change?");
  assert.equal(find(r2, "read_nudge").length, 0);
  assert.match(r2.text(), /Management expects similar conditions/);
});

test("read check: off by default; and a conversation that has not touched a file is never sent to one", async () => {
  const off = rig({ pages: TOPIC_PAGES });
  off.faux.setResponses([fauxAssistantMessage([search], { stopReason: "toolUse" }), fauxAssistantMessage([readN(1)], { stopReason: "toolUse" }), fauxAssistantMessage(LONG_ONE)]);
  await off.engine.ask("Why did net sales change?");
  assert.equal(find(off, "read_nudge").length, 0);
  const none = rig({ pages: TOPIC_PAGES, readMinPages: 3, readSearchFirst: true });
  none.faux.setResponses([fauxAssistantMessage(LONG_ONE)]); // no tool, no file in this conversation: a general answer
  await none.engine.ask("Explain what net sales mean.");
  assert.equal(find(none, "read_nudge").length, 0);
  const empty = rig({ pages: TOPIC_PAGES, readMinPages: 3, readSearchFirst: true });
  empty.faux.setResponses([fauxAssistantMessage([fauxToolCall("search", { path: "a.pdf", query: "zzzz qqqq" }, { id: "z1" })], { stopReason: "toolUse" }), fauxAssistantMessage(LONG_ONE)]);
  await empty.engine.ask("Why did net sales change?"); // a search ran and found nothing: nothing to name, and no second search is asked for
  assert.equal(find(empty, "read_nudge").length, 0);
});

test("read check: with READ_SEARCH_FIRST off (the default) an answer with no search is left alone", async () => {
  const r = rig({ pages: TOPIC_PAGES, readMinPages: 3 });
  r.faux.setResponses([fauxAssistantMessage([readN(1)], { stopReason: "toolUse" }), fauxAssistantMessage(LONG_ONE)]);
  await r.engine.ask("Why did net sales change?");
  assert.equal(find(r, "read_nudge").length, 0);
  assert.match(r.text(), /Management expects similar conditions/);
});

test("read check: with READ_SEARCH_FIRST on, a page read by number with no search gets a search-first message, then the new answer is shown", async () => {
  const r = rig({ pages: TOPIC_PAGES, readMinPages: 3, readSearchFirst: true });
  r.faux.setResponses([
    fauxAssistantMessage([readN(1)], { stopReason: "toolUse" }),
    fauxAssistantMessage(LONG_ONE),
    () => {
      const last = (r.engine.agent.state.messages as any[]).filter((m) => m.role === "user").pop();
      assert.equal(last.harness, "repair");
      assert.match(last.content[0].text, /you answered without searching a\.pdf/);
      return fauxAssistantMessage([search], { stopReason: "toolUse" });
    },
    fauxAssistantMessage([readN(2), readN(3)], { stopReason: "toolUse" }),
    fauxAssistantMessage(LONG_TWO),
  ]);
  assert.equal(await r.engine.ask("Why did net sales change?"), true);
  const nudge = find(r, "read_nudge");
  assert.equal(nudge.length, 1);
  assert.equal(nudge[0].data.kind, "search");
  assert.equal(find(r, "read_nudge_done")[0].data.after, 3);
  assert.match(r.text(), /pages explain why/);
});

test("read check: (search-first on) a long answer with no tool in a conversation that used a file earlier gets the search-first message; a short one does not", async () => {
  const r = rig({ pages: TOPIC_PAGES, readMinPages: 3, readSearchFirst: true });
  r.faux.setResponses([
    fauxAssistantMessage([search], { stopReason: "toolUse" }),
    fauxAssistantMessage([readN(1)], { stopReason: "toolUse" }),
    fauxAssistantMessage("Net sales were 32,765 in 2022."),
    fauxAssistantMessage(LONG_ONE), // second question: answered from memory
    fauxAssistantMessage([search], { stopReason: "toolUse" }),
    fauxAssistantMessage([readN(2), readN(3)], { stopReason: "toolUse" }),
    fauxAssistantMessage(LONG_TWO),
  ]);
  await r.engine.ask("What were net sales in 2022?");
  assert.equal(find(r, "read_nudge").length, 0); // short answer: exempt
  await r.engine.ask("Why did net sales change?");
  const nudge = find(r, "read_nudge");
  assert.equal(nudge.length, 1);
  assert.equal(nudge[0].data.kind, "search");
  assert.equal(nudge[0].data.looked, 0); // nothing was looked at in the second question
  r.engine.newConversation(); // /new: the next conversation has touched no file yet
  r.faux.setResponses([fauxAssistantMessage(LONG_ONE)]);
  await r.engine.ask("Explain what net sales mean.");
  assert.equal(find(r, "read_nudge").length, 1);
});

test("read check: a failed second try leaves the conversation and the first answer is shown", async () => {
  const r = rig({ pages: TOPIC_PAGES, readMinPages: 3 });
  r.faux.setResponses([fauxAssistantMessage([search], { stopReason: "toolUse" }), fauxAssistantMessage([readN(1)], { stopReason: "toolUse" }), fauxAssistantMessage(LONG_ONE), fauxAssistantMessage([])]);
  await r.engine.ask("Why did net sales change?");
  assert.equal(find(r, "read_nudge").length, 1);
  assert.equal(find(r, "read_nudge_failed").length, 1);
  assert.match(r.text(), /Management expects similar conditions/); // the first answer
  assert.equal((r.engine.agent.state.messages as any[]).filter((m) => m.harness === "repair").length, 0); // the nudge is not kept
});

test("read check: it asks for no more pages than the call limit leaves", async () => {
  const r = rig({ pages: TOPIC_PAGES, readMinPages: 5 });
  // seven calls used (search plus six reads of the same page would be repeats): use list_files calls to spend the allowance
  const filler = (i: number) => fauxAssistantMessage([fauxToolCall("list_files", { path: "." }, { id: `f${i}` })], { stopReason: "toolUse" });
  r.faux.setResponses([fauxAssistantMessage([search], { stopReason: "toolUse" }), fauxAssistantMessage([readN(1)], { stopReason: "toolUse" }), filler(1), filler(2), filler(3), filler(4), filler(5), fauxAssistantMessage(LONG_ONE), fauxAssistantMessage([readN(2)], { stopReason: "toolUse" }), fauxAssistantMessage(LONG_TWO)]);
  await r.engine.ask("Why did net sales change?");
  const nudge = find(r, "read_nudge");
  if (nudge.length) assert.ok(nudge[0].data.pages.length <= 1, "at most the one call that was left"); // 7 of 8 calls were used
});

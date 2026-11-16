import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { openWorkspace, type Workspace } from "../src/workspace.ts";
import { createDocStore } from "../src/documents/store.ts";
import type { ParsedPdf } from "../src/documents/pdf.ts";
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
  statementTool?: boolean;
  fileListFirst?: boolean;
  workspace?: Workspace;
  filesEnabled?: boolean;
  chat?: boolean;
  /** The scripted model's context window and output cap (tokens). */
  window?: number;
  maxTokens?: number;
  serverContext?: (modelId: string) => Promise<number | undefined>;
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
    docs: createDocStore(ws, async (): Promise<ParsedPdf> => ({ pages: opts.pages ?? [PAGE] })),
    ...(opts.statementTool === undefined ? {} : { statementTool: opts.statementTool }),
    ...(opts.fileListFirst === undefined ? {} : { fileListFirst: opts.fileListFirst }),
    chat: opts.chat ?? false,
    links: false,
    ...(opts.serverContext ? { serverContext: opts.serverContext } : {}),
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
  assert.match(r.text(), /\[S1\]/); // the figure read from the page carries a reference mark
  const t = types(r);
  assert.equal(t[0], "session_start");
  for (const want of ["run_start", "tool_start", "tool_end", "message", "answer_shape", "provenance", "sources", "run_end"]) assert.ok(t.includes(want), `missing ${want}`);
  assert.equal(find(r, "tool_start").length, 2);
  assert.equal(find(r, "run_end")[0].data.outcome, "ok");
  assert.equal(find(r, "provenance")[0].data.unverified.length, 0);
  assert.ok(find(r, "sources")[0].data.entries.length >= 1);
  assert.equal(find(r, "period_units").length, 0); // the named year is the column the figure sits under
});

test("an untraced figure is reported by the live check and the audit record", async () => {
  const r = rig();
  r.faux.setResponses([fauxAssistantMessage([read], { stopReason: "toolUse" }), fauxAssistantMessage("Net sales were 99,999.")]);
  assert.equal(await r.engine.ask("What were net sales in 2022?"), true);
  assert.match(r.text(), /\[check\] 1 figure not traced/);
  assert.equal(find(r, "provenance")[0].data.unverified.length, 1);
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
  assert.match(r.text(), /\[S1\]/); // the figure carries a reference mark
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
  const r = rig({ pages: [1, 2, 3, 4, 5].map(page) });
  let last = "";
  r.faux.setResponses([
    ...[1, 2, 3, 4, 5].map((n) => fauxAssistantMessage([fauxToolCall("read_page", { path: "a.pdf", page: n }, { id: `r${n}` })], { stopReason: "toolUse" })),
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
  assert.equal(find(r, "file_listing").length, 0);
});

test("a reply with thinking shows a thinking line on its own line and records the thinking size", async () => {
  const r = rig();
  r.faux.setResponses([fauxAssistantMessage([fauxThinking("let me see"), fauxText("Done.")])]);
  await r.engine.ask("hi");
  assert.match(r.text(), /thinking…\S*\nDone\./);
  assert.equal(find(r, "message").find((m) => m.data.message.role === "assistant")!.data.timing.thinkingChars, "let me see".length);
});

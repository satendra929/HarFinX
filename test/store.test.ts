import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace, type Workspace } from "../src/workspace.ts";
import { createDocStore } from "../src/documents/store.ts";
import { PdfError, type ParsedPdf } from "../src/documents/pdf.ts";

let base: string;
let ws: Workspace;

before(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "finh-store-")));
  const dir = path.join(base, "ws");
  fs.mkdirSync(dir);
  fs.mkdirSync(path.join(base, "project"));
  fs.writeFileSync(path.join(dir, "a.pdf"), "alpha");
  fs.writeFileSync(path.join(dir, "copy-of-a.pdf"), "alpha");
  fs.writeFileSync(path.join(dir, "b.pdf"), "bravo");
  ws = openWorkspace(dir, path.join(base, "project"), []);
});
after(() => fs.rmSync(base, { recursive: true, force: true }));

const counting = () => {
  const calls: string[] = [];
  const parse = async (bytes: Uint8Array): Promise<ParsedPdf> => {
    calls.push(Buffer.from(bytes).toString());
    return { pages: [`text of ${Buffer.from(bytes).toString()}`] };
  };
  return { calls, parse };
};

test("a document is parsed once, however many times and under whatever name it is asked for", async () => {
  const { calls, parse } = counting();
  const store = createDocStore(ws, parse);
  assert.deepEqual((await store.pdf("a.pdf")).pages, ["text of alpha"]);
  await store.pdf("a.pdf");
  await store.pdf("copy-of-a.pdf"); // same content: same parse
  assert.deepEqual(calls, ["alpha"]);
  await store.pdf("b.pdf");
  assert.deepEqual(calls, ["alpha", "bravo"]);
});

test("concurrent requests for the same document share one parse", async () => {
  const { calls, parse } = counting();
  const store = createDocStore(ws, parse);
  const [x, y] = await Promise.all([store.pdf("a.pdf"), store.pdf("a.pdf")]);
  assert.equal(x, y);
  assert.equal(calls.length, 1);
});

test("a changed file is parsed again", async () => {
  const { calls, parse } = counting();
  const store = createDocStore(ws, parse);
  fs.writeFileSync(path.join(ws.root, "c.pdf"), "first");
  assert.deepEqual((await store.pdf("c.pdf")).pages, ["text of first"]);
  fs.writeFileSync(path.join(ws.root, "c.pdf"), "second");
  assert.deepEqual((await store.pdf("c.pdf")).pages, ["text of second"]);
  assert.deepEqual(calls, ["first", "second"]);
});

test("a failed parse is not remembered: the next call tries again", async () => {
  let n = 0;
  const store = createDocStore(ws, async () => {
    if (++n === 1) throw new PdfError("timeout", "too slow");
    return { pages: ["ok"] };
  });
  await assert.rejects(store.pdf("a.pdf"), /too slow/);
  assert.deepEqual((await store.pdf("a.pdf")).pages, ["ok"]);
  assert.equal(n, 2);
});

test("path checks stay in the workspace: outside, missing and traversal paths never reach the parser", async () => {
  const { calls, parse } = counting();
  const store = createDocStore(ws, parse);
  for (const p of ["../x.pdf", "missing.pdf", "..\\ws\\a.pdf", "C:\\Windows\\win.ini", ""]) {
    await assert.rejects(store.pdf(p), /not found or not allowed/);
  }
  assert.equal(calls.length, 0);
});

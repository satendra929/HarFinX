import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace } from "../src/workspace.ts";
import { readFileTool, CHUNK_CHARS } from "../src/tools/readFile.ts";
import { DEFAULT_LIMITS } from "../src/guard.ts";

let base: string;
let tool: ReturnType<typeof readFileTool>;
const run = async (args: object) => {
  const r = await tool.execute("id", args as any);
  return (r.content[0] as any).text as string;
};

before(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "finh-tool-")));
  const ws = path.join(base, "ws");
  fs.mkdirSync(ws);
  fs.mkdirSync(path.join(base, "project"));
  fs.writeFileSync(path.join(ws, "small.csv"), "item,amount\nrevenue,500\n");
  fs.writeFileSync(path.join(ws, "long.txt"), "a".repeat(CHUNK_CHARS) + "b".repeat(100));
  fs.writeFileSync(path.join(base, "secret.txt"), "SECRET");
  tool = readFileTool(openWorkspace(ws, path.join(base, "project"), []));
});
after(() => fs.rmSync(base, { recursive: true, force: true }));

test("chunk size leaves room for the note under the guard's per-result cap", () => {
  assert.ok(CHUNK_CHARS + 200 < DEFAULT_LIMITS.maxOutputChars);
});

test("returns a small file whole and marks the end", async () => {
  const t = await run({ path: "small.csv" });
  assert.ok(t.startsWith("item,amount\nrevenue,500"));
  assert.match(t, /end of file/);
});

test("long file comes in chunks that tell the model how to continue", async () => {
  const first = await run({ path: "long.txt" });
  assert.match(first, new RegExp(`offset=${CHUNK_CHARS} for more`));
  assert.ok(!first.includes("b"));
  const second = await run({ path: "long.txt", offset: CHUNK_CHARS });
  assert.ok(second.startsWith("b".repeat(100)));
  assert.match(second, /end of file/);
});

test("offset past the end is explained, not an error", async () => {
  assert.match(await run({ path: "small.csv", offset: 9999 }), /past the end/);
});

test("rejects a bad offset", async () => {
  await assert.rejects(run({ path: "small.csv", offset: -1 }), /offset/);
  await assert.rejects(run({ path: "small.csv", offset: 1.5 }), /offset/);
});

test("cannot leave the workspace or read what does not exist", async () => {
  for (const p of ["../secret.txt", "nope.csv", "..\\secret.txt", "C:\\Windows\\win.ini"]) {
    await assert.rejects(run({ path: p }), /not found or not allowed/);
  }
});

test("exposes no parameter that could name a different root", () => {
  assert.deepEqual(Object.keys((tool.parameters as any).properties).sort(), ["offset", "path"]);
});

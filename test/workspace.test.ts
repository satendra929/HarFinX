import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureWorkspaceDir, openWorkspace, type Workspace } from "../src/workspace.ts";

let base: string;
let ws: Workspace;
let outside: string;
let project: string;
const NOPE = /not found or not allowed/;

before(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "finh-test-")));
  const wsDir = path.join(base, "ws");
  outside = path.join(base, "outside");
  project = path.join(base, "project");
  for (const d of [wsDir, outside, project, path.join(wsDir, "sub")]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(wsDir, "ok.txt"), "hello");
  fs.writeFileSync(path.join(wsDir, "sub", "deep.txt"), "deep");
  fs.writeFileSync(path.join(wsDir, "..foo"), "dotdot-name"); // legal name that starts with ".."
  fs.writeFileSync(path.join(wsDir, "bin.dat"), Buffer.from([1, 0, 2]));
  fs.writeFileSync(path.join(wsDir, "big.txt"), "x".repeat(100));
  fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET");
  fs.writeFileSync(path.join(project, ".env"), "KEY=1");
  fs.symlinkSync(outside, path.join(wsDir, "escape"), "junction"); // junctions need no admin
  ws = openWorkspace(wsDir, project, [path.join(base, "home")]);
});

after(() => fs.rmSync(base, { recursive: true, force: true }));

test("reads files inside the workspace", async () => {
  assert.equal(await ws.readText("ok.txt"), "hello");
  assert.equal(await ws.readText("sub/deep.txt"), "deep");
  assert.equal(await ws.readText("sub\\deep.txt"), "deep");
  assert.equal(await ws.readText("./ok.txt"), "hello");
  assert.equal(await ws.readText("..foo"), "dotdot-name"); // not mistaken for ".."
  assert.equal(await ws.readText("OK.TXT"), "hello"); // NTFS is case-insensitive
});

// Lazy (functions) so entries that depend on the temp dir are evaluated after before() runs.
const attacks: [string, () => string][] = ([
  ["parent traversal", "../outside/secret.txt"],
  ["nested traversal", "sub/../../outside/secret.txt"],
  ["absolute path", () => path.join(base, "outside", "secret.txt")],
  ["rooted, no drive", "\\outside\\secret.txt"],
  ["leading slash", "/outside/secret.txt"],
  ["drive-relative", "C:secret.txt"],
  ["UNC", "\\\\server\\share\\x.txt"],
  ["long-path prefix", "\\\\?\\C:\\Windows\\win.ini"],
  ["device prefix", "\\\\.\\C:\\Windows\\win.ini"],
  ["NT prefix", "\\??\\C:\\Windows\\win.ini"],
  ["alternate data stream", "ok.txt::$DATA"],
  ["named stream", "ok.txt:hidden"],
  ["device name CON", "CON"],
  ["device name with extension", "nul.txt"],
  ["device name trailing dot", "CON."],
  ["device name trailing space", "NUL .txt"],
  ["device name in subpath", "sub/aux"],
  ["superscript device", "COM\u00b9"],
  ["CONIN$", "CONIN$"],
  ["trailing dot", "ok.txt."],
  ["trailing space", "ok.txt "],
  ["wildcard", "*.txt"],
  ["question mark", "ok?.txt"],
  ["NUL byte", "ok.txt\u0000.png"],
  ["control char", "ok\u001b.txt"],
  ["empty", ""],
  ["junction pointing outside", "escape/secret.txt"],
  ["missing file", "nope.txt"],
  ["directory", "sub"],
  ["workspace root itself", "."],
] as [string, string | (() => string)][]).map(([n, p]) => [n, typeof p === "function" ? p : () => p]);
for (const [name, p] of attacks) {
  test(`blocks: ${name}`, async () => {
    await assert.rejects(ws.readText(p()), NOPE);
  });
  test(`blocks (readBytes): ${name}`, async () => {
    await assert.rejects(ws.readBytes(p()), NOPE);
  });
}

test("blocks non-string input", async () => {
  await assert.rejects(ws.readText(undefined as unknown as string), NOPE);
  await assert.rejects(ws.readText({} as unknown as string), NOPE);
  await assert.rejects(ws.readBytes(undefined as unknown as string), NOPE);
  await assert.rejects(ws.readBytes({} as unknown as string), NOPE);
});

test("readBytes returns the raw bytes (binary is fine), with its own size cap and abort handling", async () => {
  assert.deepEqual([...(await ws.readBytes("bin.dat"))], [1, 0, 2]);
  assert.equal((await ws.readBytes("sub/deep.txt")).toString("utf8"), "deep");
  await assert.rejects(ws.readBytes("big.txt", { maxBytes: 10 }), /too large/);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(ws.readBytes("ok.txt", { signal: ac.signal }));
});

test("enforces size cap and rejects binary", async () => {
  await assert.rejects(ws.readText("big.txt", { maxBytes: 10 }), /too large/);
  await assert.rejects(ws.readText("bin.dat"), /binary/);
});

test("default size caps apply without options: 1 MB of text, 50 MB of bytes (sparse files, nothing is read)", async () => {
  const big = path.join(ws.root, "huge-sparse.bin");
  fs.writeFileSync(big, "");
  fs.truncateSync(big, 50_000_001);
  await assert.rejects(ws.readText("huge-sparse.bin"), /too large \(50000001 bytes, limit 1000000\)/);
  await assert.rejects(ws.readBytes("huge-sparse.bin"), /too large \(50000001 bytes, limit 50000000\)/);
  fs.truncateSync(big, 1_000_001);
  await assert.rejects(ws.readText("huge-sparse.bin"), /limit 1000000/);
  assert.equal((await ws.readBytes("huge-sparse.bin")).length, 1_000_001); // under the bytes cap: read in full
  fs.rmSync(big);
});

test("honors an aborted signal", async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(ws.readText("ok.txt", { signal: ac.signal }));
});

test("startup refusals", () => {
  const wsDir = path.join(base, "ws");
  const home = path.join(base, "home");
  fs.mkdirSync(home, { recursive: true });
  assert.throws(() => openWorkspace(path.join(base, "missing"), project, []), /not found/);
  assert.throws(() => openWorkspace(path.join(wsDir, "ok.txt"), project, []), /not a directory/);
  assert.throws(() => openWorkspace(path.parse(base).root, project, []), /drive root/);
  assert.throws(() => openWorkspace(home, project, [home]), /home folder/); // is home
  assert.throws(() => openWorkspace(base, project, [home]), /home folder/); // contains home
  assert.throws(() => openWorkspace(project, project, []), /project folder/); // is project (.env!)
  assert.throws(() => openWorkspace(base, project, []), /project folder/); // contains project
  assert.doesNotThrow(() => openWorkspace(wsDir, project, [home]));
});

test("ensureWorkspaceDir creates a missing folder only inside the project", () => {
  const made = ensureWorkspaceDir("fresh-ws", project);
  assert.equal(made, path.join(project, "fresh-ws"));
  assert.ok(fs.statSync(made!).isDirectory());
  assert.equal(ensureWorkspaceDir("fresh-ws", project), undefined); // already exists: nothing to do
  assert.doesNotThrow(() => openWorkspace("fresh-ws", project, []));

  // Outside the project (absolute or via ..): not created, openWorkspace still refuses.
  const outsideNew = path.join(base, "outside-new");
  assert.equal(ensureWorkspaceDir(outsideNew, project), undefined);
  assert.equal(ensureWorkspaceDir(path.join("..", "escaped"), project), undefined);
  assert.equal(fs.existsSync(outsideNew), false);
  assert.equal(fs.existsSync(path.join(base, "escaped")), false);
  assert.throws(() => openWorkspace(outsideNew, project, []), /not found/);

  // A file in the way: no crash, nothing created.
  fs.writeFileSync(path.join(project, "afile"), "x");
  assert.equal(ensureWorkspaceDir(path.join("afile", "sub"), project), undefined);
});

test("relative WORKSPACE_DIR resolves against the project, not the cwd", () => {
  fs.mkdirSync(path.join(project, "data"), { recursive: true });
  const w = openWorkspace("data", project, []);
  assert.equal(w.root, fs.realpathSync.native(path.join(project, "data")));
});

test("list: regular files only, sorted, relative with forward slashes; junctions are not followed; dot-names hidden", () => {
  fs.writeFileSync(path.join(ws.root, ".hidden"), "x");
  fs.mkdirSync(path.join(ws.root, ".git-like"), { recursive: true });
  fs.writeFileSync(path.join(ws.root, ".git-like", "inside.txt"), "x");
  const { files, truncated } = ws.list();
  const names = files.map((f) => f.path);
  assert.ok(names.includes("ok.txt") && names.includes("sub/deep.txt"));
  assert.ok(!names.some((n) => n.startsWith("escape")), "the junction to an outside folder must not be listed or followed");
  assert.ok(!names.some((n) => n.includes("secret")));
  assert.ok(!names.some((n) => n.startsWith(".")), "dot-names are hidden (also the legal name ..foo)");
  assert.deepEqual(names, [...names].sort());
  assert.equal(files.find((f) => f.path === "ok.txt")!.size, 5);
  assert.equal(truncated, false);
  fs.rmSync(path.join(ws.root, ".hidden"));
  fs.rmSync(path.join(ws.root, ".git-like"), { recursive: true });
});

test("list: every listed path can be read back through the same gate", async () => {
  for (const f of ws.list().files) await assert.doesNotReject(ws.readBytes(f.path));
});

test("list: caps entries and depth, and says when it cut the list", () => {
  const many = path.join(ws.root, "many");
  fs.mkdirSync(many);
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(many, `f${String(i).padStart(2, "0")}.txt`), "x");
  const capped = ws.list({ maxEntries: 10 });
  assert.equal(capped.files.length, 10);
  assert.equal(capped.truncated, true);
  const deep = path.join(ws.root, "d1", "d2", "d3");
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, "bottom.txt"), "x");
  assert.ok(ws.list({ maxDepth: 4 }).files.some((f) => f.path === "d1/d2/d3/bottom.txt"));
  const shallow = ws.list({ maxDepth: 2 });
  assert.ok(!shallow.files.some((f) => f.path.startsWith("d1/d2/")));
  assert.equal(shallow.truncated, true);
  fs.rmSync(many, { recursive: true });
  fs.rmSync(path.join(ws.root, "d1"), { recursive: true });
});

test("list: names the read path would refuse (devices, trailing dots or spaces) are left out", () => {
  // Windows cannot create most such names through normal APIs; a trailing-space name is possible via the \?\ prefix.
  const odd = `\\?\${path.join(ws.root, "trailing.txt ")}`;
  let made = false;
  try {
    fs.writeFileSync(odd, "x");
    made = true;
  } catch {
    /* not creatable here: nothing to test */
  }
  if (made) {
    assert.ok(!ws.list().files.some((f) => f.path.startsWith("trailing.txt")));
    fs.rmSync(odd);
  }
});

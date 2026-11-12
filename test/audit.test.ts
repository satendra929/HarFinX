import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuditLog } from "../src/audit.ts";

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace);
  return { base, workspace, audit: path.join(base, "audit") };
}
const lines = (file: string) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean);

test("writes one valid JSON line per record with increasing seq and ts", () => {
  const { base, workspace, audit } = setup();
  const log = createAuditLog(audit, workspace, base);
  log.write("a", { x: 1 });
  log.write("b");
  log.write("c", { nested: { y: [1, 2] } });
  const recs = lines(log.path).map((l) => JSON.parse(l));
  assert.equal(recs.length, 3);
  assert.deepEqual(recs.map((r) => r.seq), [1, 2, 3]);
  assert.deepEqual(recs.map((r) => r.type), ["a", "b", "c"]);
  assert.ok(recs.every((r) => r.v === 1 && r.session === log.session));
  assert.ok(recs.every((r, i) => i === 0 || r.ts >= recs[i - 1].ts));
  assert.equal(recs[0].x, 1);
});

test("newlines and control characters in content stay inside one line", () => {
  const { base, workspace, audit } = setup();
  const log = createAuditLog(audit, workspace, base);
  const nasty = "line1\nline2\r\n\u001b[31mred\u0000 end";
  log.write("m", { text: nasty });
  const ls = lines(log.path);
  assert.equal(ls.length, 1);
  assert.equal(JSON.parse(ls[0]).text, nasty); // lossless
});

test("each session gets its own new file; existing logs are never touched", () => {
  const { base, workspace, audit } = setup();
  const a = createAuditLog(audit, workspace, base);
  a.write("first");
  const before = fs.readFileSync(a.path, "utf8");
  const b = createAuditLog(audit, workspace, base);
  b.write("second");
  assert.notEqual(a.path, b.path);
  assert.equal(fs.readFileSync(a.path, "utf8"), before);
  assert.equal(fs.readdirSync(audit).length, 2);
});

test("data may not overwrite the envelope fields", () => {
  const { base, workspace, audit } = setup();
  const log = createAuditLog(audit, workspace, base);
  for (const k of ["v", "seq", "ts", "session", "type"]) {
    assert.throws(() => log.write("x", { [k]: "evil" }), /reserved key/);
  }
  assert.equal(lines(log.path).length, 0); // nothing was written, seq not consumed
  log.write("ok");
  assert.equal(JSON.parse(lines(log.path)[0]).seq, 1);
});

test("refuses an audit folder that is, contains, or is inside the workspace", () => {
  const { base, workspace } = setup();
  assert.throws(() => createAuditLog(workspace, workspace, base), /overlaps the workspace/);
  assert.throws(() => createAuditLog(path.join(workspace, "logs"), workspace, base), /overlaps the workspace/);
  assert.throws(() => createAuditLog(base, workspace, base), /overlaps the workspace/); // contains it
  assert.throws(() => createAuditLog(path.join(workspace, "..", "workspace"), workspace, base), /overlaps the workspace/);
});

test("a failing write throws (caller must stop the run)", () => {
  const { base, workspace, audit } = setup();
  const log = createAuditLog(audit, workspace, base);
  log.write("ok");
  fs.rmSync(log.path);
  fs.mkdirSync(log.path); // a directory where the file was: appends now fail
  assert.throws(() => log.write("lost"));
});

test("relative audit folder resolves against the project root, not the cwd", () => {
  const { base, workspace } = setup();
  const log = createAuditLog("audit", workspace, base);
  assert.ok(log.path.toLowerCase().startsWith(fs.realpathSync.native(base).toLowerCase()));
});

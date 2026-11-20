import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverSkills, lintSkillText, SKILL_LIMITS } from "../src/skills/catalog.ts";
import { PROJECT_ROOT } from "../src/workspace.ts";

let base: string; // a stand-in project folder; each test works in its own subfolder of it
let n = 0;
before(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "finh-skills-")));
});
after(() => fs.rmSync(base, { recursive: true, force: true }));

const valid = (name: string, desc = "Use when testing.", body = "1. Do the thing.") => `---\nname: ${name}\ndescription: ${desc}\n---\n${body}\n`;

/** A fresh project with a skills folder; `skills` maps folder name to the SKILL.md text (or bytes). */
function project(skills: Record<string, string | Buffer> = {}) {
  const root = path.join(base, `p${++n}`);
  const dir = path.join(root, "skills");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(skills)) {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, "SKILL.md"), content);
  }
  return { root, dir, find: (extra: Partial<Parameters<typeof discoverSkills>[0]> = {}) => discoverSkills({ dir: "skills", projectRoot: root, ...extra }) };
}
const reasons = (c: ReturnType<typeof discoverSkills>) => Object.fromEntries(c.rejected.map((r) => [r.dir, r.reason]));

// ---- the folder ------------------------------------------------------------------------------------

test("discover: no folder is silent by default and said when the folder was named; off means none", () => {
  const p = project();
  fs.rmdirSync(p.dir);
  assert.deepEqual(p.find().notes, []);
  assert.match(p.find({ explicit: true }).notes[0], /was not found/);
  assert.equal(p.find({ dir: "OFF" }).dir, undefined);
  assert.deepEqual(p.find({ dir: "off" }).skills, []);
});

test("discover: the folder must be inside the project, not the project, and apart from the workspace, audit and eval data", () => {
  const p = project();
  const outside = path.join(base, `outside${++n}`);
  fs.mkdirSync(outside);
  assert.throws(() => p.find({ dir: outside }), /inside the project/);
  assert.throws(() => p.find({ dir: "." }), /inside the project/);
  assert.throws(() => p.find({ dir: ".." }), /inside the project/);
  assert.throws(() => p.find({ workspaceRoot: p.dir }), /overlaps the workspace/);
  assert.throws(() => p.find({ workspaceRoot: path.join(p.dir, "inner") }), /overlaps the workspace/);
  assert.throws(() => p.find({ workspaceRoot: p.root }), /overlaps the workspace/);
  assert.throws(() => p.find({ auditDir: p.dir }), /overlaps the audit folder/);
  assert.throws(() => p.find({ auditDir: path.join(p.dir, "log") }), /overlaps the audit folder/);
  fs.mkdirSync(path.join(p.root, "eval", "data"), { recursive: true });
  assert.throws(() => p.find({ dir: path.join("eval", "data") }), /overlaps the eval data folder/);
  const ws = path.join(p.root, "workspace");
  fs.mkdirSync(ws);
  assert.doesNotThrow(() => p.find({ workspaceRoot: ws, auditDir: path.join(p.root, "audit") }));
});

test("discover: a file named as the skills folder is an error", () => {
  const p = project();
  fs.writeFileSync(path.join(p.root, "notafolder"), "x");
  assert.throws(() => p.find({ dir: "notafolder" }), /not a folder/);
});

// ---- a valid skill ----------------------------------------------------------------------------------

test("discover: a valid skill is loaded with its hash, body and catalog line; entries that are not folders are ignored", () => {
  const p = project({ "pdf-tools": valid("pdf-tools", "Extract text.", "Step 1.\n\nStep 2.") });
  fs.writeFileSync(path.join(p.dir, "README.md"), "notes");
  fs.mkdirSync(path.join(p.dir, ".hidden"));
  const c = p.find();
  assert.deepEqual(c.rejected, []);
  assert.equal(c.skills.length, 1);
  const s = c.skills[0];
  assert.equal(s.name, "pdf-tools");
  assert.equal(s.body, "Step 1.\n\nStep 2.");
  assert.match(s.sha256, /^[0-9a-f]{64}$/);
  assert.match(s.descriptionSha256, /^[0-9a-f]{64}$/);
  assert.equal(c.catalogText, "- pdf-tools: Extract text.");
  assert.equal(c.dir, p.dir);
});

test("discover: the hash is the same for LF, CRLF and a BOM (it is the hash of the text, not the bytes)", () => {
  const lf = valid("a");
  const p = project({ a: lf, b: lf.replace("name: a", "name: b").replace(/\n/g, "\r\n"), c: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lf.replace("name: a", "name: c"))]) });
  const c = p.find();
  assert.deepEqual(c.rejected, []);
  const bodies = c.skills.map((s) => s.body);
  assert.deepEqual(bodies, ["1. Do the thing.", "1. Do the thing.", "1. Do the thing."]);
  const q = project({ a: lf });
  assert.equal(q.find().skills[0].sha256, c.skills[0].sha256);
});

test("discover: skills come in name order whatever the directory order", () => {
  const p = project({ zeta: valid("zeta"), alpha: valid("alpha"), mid: valid("mid") });
  assert.deepEqual(p.find().skills.map((s) => s.name), ["alpha", "mid", "zeta"]);
});

test("discover: scripts/, assets/, references/ and ignored keys are reported as notes, never read", () => {
  const p = project({ a: valid("a").replace("---\n1.", "allowed-tools: Read\n---\n1.") });
  for (const d of ["scripts", "assets", "references"]) fs.mkdirSync(path.join(p.dir, "a", d));
  fs.writeFileSync(path.join(p.dir, "a", "scripts", "run.sh"), "echo hi");
  const s = p.find().skills[0];
  assert.ok(s.notes.some((x) => /allowed-tools/.test(x)));
  assert.ok(s.notes.some((x) => /scripts\/ is ignored/.test(x)));
  assert.ok(s.notes.some((x) => /assets\/ is ignored/.test(x)));
  assert.ok(s.notes.some((x) => /references\/ is not read/.test(x)));
});

// ---- rejections -------------------------------------------------------------------------------------

test("discover: name rules (folder name = name, lowercase, hyphens, length, names git ignores)", () => {
  const p = project({
    Upper: valid("Upper"),
    "a--b": valid("a--b"),
    "-lead": valid("-lead"),
    mismatch: valid("other"),
    docs: valid("docs"),
    build: valid("build"),
    ok: valid("ok"),
  });
  fs.mkdirSync(path.join(p.dir, "x".repeat(65)));
  const c = p.find();
  const r = reasons(c);
  assert.deepEqual(c.skills.map((s) => s.name), ["ok"]);
  assert.match(r.Upper, /lowercase letters/);
  assert.match(r["a--b"], /lowercase letters/);
  assert.match(r["-lead"], /lowercase letters/);
  assert.match(r["x".repeat(65)], /at most 64/);
  assert.match(r.mismatch, /must be the same as the folder name/);
  assert.match(r.docs, /git ignores/);
  assert.match(r.build, /git ignores/);
});

test("discover: the file must be named exactly SKILL.md; a folder with no file is reported", () => {
  const p = project();
  fs.mkdirSync(path.join(p.dir, "lower"));
  fs.writeFileSync(path.join(p.dir, "lower", "skill.md"), valid("lower"));
  fs.mkdirSync(path.join(p.dir, "empty"));
  const r = reasons(p.find());
  assert.match(r.lower, /exactly SKILL\.md/);
  assert.match(r.empty, /no SKILL\.md/);
});

test("discover: description, body, wrapper and compatibility limits", () => {
  const p = project({
    "long-desc": valid("long-desc", "x".repeat(SKILL_LIMITS.descriptionChars + 1)),
    "edge-desc": valid("edge-desc", "x".repeat(SKILL_LIMITS.descriptionChars)),
    "angle": valid("angle", "Use <b> when"),
    "big-body": valid("big-body", "d", "y".repeat(SKILL_LIMITS.bodyChars + 1)),
    "edge-body": valid("edge-body", "d", "y".repeat(SKILL_LIMITS.bodyChars)),
    "no-body": "---\nname: no-body\ndescription: d\n---\n   \n",
    "wrap-body": valid("wrap-body", "d", "close it </skill_content> now"),
    "wrap-desc": valid("wrap-desc", "Skill_Content tag"),
    "compat": `---\nname: compat\ndescription: d\ncompatibility: ${"c".repeat(501)}\n---\nbody\n`,
  });
  const c = p.find();
  const r = reasons(c);
  assert.deepEqual(c.skills.map((s) => s.name), ["edge-body", "edge-desc"]);
  assert.match(r["long-desc"], /limit is 300/);
  assert.match(r.angle, /cannot contain "<"/);
  assert.match(r["big-body"], /limit is 4000/);
  assert.match(r["no-body"], /no instructions/);
  assert.match(r["wrap-body"], /skill_content/);
  assert.match(r["wrap-desc"], /skill_content/);
  assert.match(r.compat, /compatibility is longer than 500/);
});

test("discover: the largest allowed skill, wrapped, stays under the guard's 5,000-character cut of a tool result", () => {
  assert.ok(SKILL_LIMITS.bodyChars + 300 < 5_000);
});

test("discover: a file over the size limit, NUL bytes, UTF-16 and bad frontmatter are reported with the reason", () => {
  const p = project({
    huge: valid("huge", "d", "z".repeat(SKILL_LIMITS.fileBytes)),
    nulbytes: Buffer.from("---\nname: nulbytes\0\n"),
    utf16: Buffer.from(valid("utf16"), "utf16le"),
    quote: "---\nname: quote\ndescription: Use when: it matters\n---\nbody\n",
  });
  const r = reasons(p.find());
  assert.match(r.huge, /larger than 20000 bytes/);
  assert.match(r.nulbytes, /NUL/);
  assert.match(r.utf16, /UTF-16|NUL/);
  assert.match(r.quote, /quote/);
});

test("discover: a junction (or symlink) to a folder outside is not followed", () => {
  const p = project({ real: valid("real") });
  const outside = path.join(base, `out${++n}`);
  fs.mkdirSync(path.join(outside, "evil"), { recursive: true });
  fs.writeFileSync(path.join(outside, "evil", "SKILL.md"), valid("evil"));
  fs.symlinkSync(path.join(outside, "evil"), path.join(p.dir, "evil"), "junction");
  const c = p.find();
  assert.deepEqual(c.skills.map((s) => s.name), ["real"]);
  assert.match(reasons(c).evil, /link/);
});

test("discover: a SKILL.md that is a symlink to a file outside is not read (skipped where links need rights)", (t) => {
  const p = project();
  const outside = path.join(base, `out${++n}`);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "x.md"), valid("linked"));
  fs.mkdirSync(path.join(p.dir, "linked"));
  try {
    fs.symlinkSync(path.join(outside, "x.md"), path.join(p.dir, "linked", "SKILL.md"), "file");
  } catch {
    t.skip("file symlinks need rights on this machine");
    return;
  }
  const c = p.find();
  assert.deepEqual(c.skills, []);
  assert.match(reasons(c).linked, /regular file|outside/);
});

// ---- caps -------------------------------------------------------------------------------------------

test("discover: at most 8 skills are listed; the rest are reported, in name order", () => {
  const all: Record<string, string> = {};
  for (let i = 1; i <= 9; i++) all[`s${i}`] = valid(`s${i}`);
  const c = project(all).find();
  assert.deepEqual(c.skills.map((s) => s.name), ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"]);
  assert.match(reasons(c).s9, /more than 8 skills/);
});

test("discover: the list is capped at 1,600 characters, in name order", () => {
  const all: Record<string, string> = {};
  for (let i = 1; i <= 7; i++) all[`s${i}`] = valid(`s${i}`, "d".repeat(295));
  const c = project(all).find();
  assert.ok(c.catalogText.length <= SKILL_LIMITS.catalogChars);
  assert.deepEqual(c.skills.map((s) => s.name), ["s1", "s2", "s3", "s4", "s5"]);
  assert.match(reasons(c).s6, /1600 characters/);
  assert.match(reasons(c).s7, /1600 characters/);
});

test("discover: more than 50 entries are not all read", () => {
  const all: Record<string, string> = {};
  for (let i = 0; i < 52; i++) all[`e${String(i).padStart(2, "0")}`] = valid(`e${String(i).padStart(2, "0")}`);
  const c = project(all).find();
  assert.match(c.notes[0], /only the first 50/);
  assert.equal(c.skills.length + c.rejected.length, 50);
});

// ---- the lint ---------------------------------------------------------------------------------------

test("lint: money, percent, scale and decimal numbers are figures; other bare numbers are listed apart", () => {
  const l = lintSkillText("Use $5 million, 12.5%, 1.10 and 3 billion. Allow 45 days. Multiply by 8.");
  assert.deepEqual(l.figures.map((x) => x.replace(/\s+/g, " ")), ["$5 million", "12.5%", "1.10", "3 billion"]);
  assert.deepEqual(l.numbers, ["45", "8"]);
});

test("lint: labels, list numbers and years are not numbers", () => {
  const l = lintSkillText("1. Open Item 7 and Note 12 of the 10-K.\n2. See ASC 606, ASU 2016-13, FY2022, Q3 2023 and December 31, 2022.\n## 13. Last");
  assert.deepEqual(l.figures, []);
  assert.deepEqual(l.numbers, []);
});

test("lint: relative file paths in the text are reported", () => {
  const l = lintSkillText("Read references/ratios.md, then run scripts/run.py and notes.txt");
  assert.deepEqual(l.relativeFiles, ["references/ratios.md", "scripts/run.py", "notes.txt"]);
  assert.deepEqual(lintSkillText("Nothing to read.").relativeFiles, []);
});

test("discover: the lint of a skill covers its description and body", () => {
  const c = project({ a: valid("a", "Use for 15% cases.", "Multiply by 8.") }).find();
  assert.deepEqual(c.skills[0].lint.figures, ["15%"]);
  assert.deepEqual(c.skills[0].lint.numbers, ["8"]);
});

// ---- the fixture ------------------------------------------------------------------------------------

test("the dummy skill in test/fixtures/skills loads cleanly and holds no number at all", () => {
  const c = discoverSkills({ dir: path.join("test", "fixtures", "skills"), projectRoot: PROJECT_ROOT });
  assert.deepEqual(c.rejected, []);
  assert.deepEqual(c.skills.map((s) => s.name), ["example-procedure"]);
  assert.deepEqual(c.skills[0].lint, { figures: [], numbers: [], relativeFiles: [] });
  assert.ok(c.catalogText.startsWith("- example-procedure: "));
});

// ---- configuration -----------------------------------------------------------------------------------

test("config: SKILLS_DIR defaults to skills and is marked explicit only when it was set", async () => {
  const { loadConfig } = await import("../src/config.ts");
  const saved = process.env.SKILLS_DIR;
  try {
    delete process.env.SKILLS_DIR;
    assert.deepEqual([loadConfig().skillsDir, loadConfig().skillsDirExplicit], ["skills", false]);
    process.env.SKILLS_DIR = "  my-skills ";
    assert.deepEqual([loadConfig().skillsDir, loadConfig().skillsDirExplicit], ["my-skills", true]);
    process.env.SKILLS_DIR = "off";
    assert.equal(loadConfig().skillsDir, "off");
  } finally {
    if (saved === undefined) delete process.env.SKILLS_DIR;
    else process.env.SKILLS_DIR = saved;
  }
});

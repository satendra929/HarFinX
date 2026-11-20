import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSkill, skillText } from "../src/skills/parse.ts";

const text = (s: string | Buffer) => skillText(typeof s === "string" ? Buffer.from(s, "utf8") : s);
const ok = (src: string) => {
  const r = parseSkill(src);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  return r.value;
};
const bad = (src: string, re: RegExp) => {
  const r = parseSkill(src);
  assert.equal(r.ok, false, "expected a rejection");
  if (!r.ok) assert.match(r.reason, re);
};
const doc = (front: string, body = "Do it.") => `---\n${front}\n---\n${body}\n`;

// ---- skillText: the bytes -------------------------------------------------------------------------

test("skillText: plain UTF-8 passes unchanged, tabs and line feeds are allowed", () => {
  const r = text("a\tb\nc é");
  assert.ok(r.ok && r.text === "a\tb\nc é");
});

test("skillText: one leading BOM is removed, CRLF becomes LF, so the hash does not depend on the editor", () => {
  const a = text(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("x\r\ny\r\n")]));
  const b = text("x\ny\n");
  assert.ok(a.ok && b.ok && a.text === b.text);
});

test("skillText: UTF-16, NUL, invalid UTF-8, a lone CR, control and invisible characters are refused with a reason", () => {
  for (const [bytes, re] of [
    [Buffer.from([0xff, 0xfe, 0x61, 0x00]), /UTF-16/],
    [Buffer.from([0xfe, 0xff, 0x00, 0x61]), /UTF-16/],
    [Buffer.from([0x61, 0x00, 0x62]), /NUL/],
    [Buffer.from([0xc3, 0x28]), /not valid UTF-8/],
    [Buffer.from("a\rb"), /carriage return/],
    [Buffer.from("a\u0001b"), /control characters/],
    [Buffer.from("a​b"), /invisible/],
    [Buffer.from("a‮b"), /invisible/],
    [Buffer.from("﻿﻿x"), /invisible/], // only ONE leading BOM is removed
  ] as [Buffer, RegExp][]) {
    const r = text(bytes);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, re);
  }
});

// ---- parseSkill: what is accepted -----------------------------------------------------------------

test("parse: name, description and a body; the body is trimmed and keeps later --- lines", () => {
  const v = ok("---\nname: pdf-tools\ndescription: Extract text.\n---\n\nStep one.\n\n---\n\nStep two.\n\n");
  assert.equal(v.name, "pdf-tools");
  assert.equal(v.description, "Extract text.");
  assert.equal(v.body, "Step one.\n\n---\n\nStep two.");
});

test("parse: the specification's own example fields", () => {
  const v = ok(
    doc(
      [
        "name: pdf-processing",
        "description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents or when the user mentions PDFs, forms, or document extraction.",
        "license: Proprietary. LICENSE.txt has complete terms",
        "compatibility: Requires git, docker, jq, and access to the internet",
        "metadata:",
        "  author: example-org",
        '  version: "1.0"',
        "allowed-tools: Bash(git:*) Bash(jq:*) Read",
      ].join("\n"),
    ),
  );
  assert.equal(v.license, "Proprietary. LICENSE.txt has complete terms");
  assert.equal(v.compatibility, "Requires git, docker, jq, and access to the internet");
  assert.deepEqual([...v.metadata], [["author", "example-org"], ["version", "1.0"]]);
  assert.deepEqual(v.ignoredKeys, ["allowed-tools"]);
});

test("parse: quoted values (single with '' and double with \\\" and \\\\)", () => {
  assert.equal(ok(doc("name: a\ndescription: 'It''s ready'")).description, "It's ready");
  assert.equal(ok(doc('name: a\ndescription: "say \\"hi\\" \\\\ now"')).description, 'say "hi" \\ now');
  assert.equal(ok(doc('name: a\ndescription: "Use when: the user asks"')).description, "Use when: the user asks"); // the colon is fine inside quotes
  assert.equal(ok(doc("name: a\ndescription: 'x' # a comment")).description, "x");
});

test("parse: a plain value may hold a colon with no space after it, a # with no space before it, and a quote inside", () => {
  assert.equal(ok(doc("name: a\ndescription: Use http://example.test for C# and it's fine")).description, "Use http://example.test for C# and it's fine");
});

test("parse: a quoted number or boolean is a string", () => {
  assert.equal(ok(doc('name: "123"\ndescription: x')).name, "123");
});

test("parse: description as a folded block, > and >-, one common indentation", () => {
  const v1 = ok(doc("name: a\ndescription: >\n  First line\n  second line\n  third"));
  assert.equal(v1.description, "First line second line third");
  const v2 = ok(doc("name: a\ndescription: >-\n    Indented four\n    still four\nlicense: MIT"));
  assert.equal(v2.description, "Indented four still four");
  assert.equal(v2.license, "MIT");
  // a blank line AFTER the block, before the next key, is fine
  assert.equal(ok(doc("name: a\ndescription: >\n  Only\n\nlicense: MIT")).description, "Only");
});

test("parse: comments and blank lines between keys are skipped", () => {
  const v = ok(doc("# a comment\nname: a\n\ndescription: b\n  # an indented comment is read past only under a skipped key"));
  assert.equal(v.name, "a");
});

test("parse: an unknown key, with or without a list under it, is read past and reported, never a failure", () => {
  const v = ok(doc("name: a\ndescription: b\nallowed-tools:\n  - Read\n  - Bash\ndisable-model-invocation: true\nfoo: [1, 2]"));
  assert.deepEqual(v.ignoredKeys, ["allowed-tools", "disable-model-invocation", "foo"]);
});

test("parse: metadata values stay raw strings and an unreadable line is read past", () => {
  const v = ok(doc("name: a\ndescription: b\nmetadata:\n  version: 1.10\n  note: 'q'\n   weird continuation\n  - item"));
  assert.deepEqual([...v.metadata], [["version", "1.10"], ["note", "q"]]);
});

// ---- parseSkill: what is rejected -----------------------------------------------------------------

test("parse: the frontmatter must open on the first line and close on a line that is exactly ---", () => {
  bad("name: a\n---\n", /must start with a line that holds only ---/);
  bad("\n---\nname: a\n---\n", /must start with/);
  bad("--- # x\nname: a\ndescription: b\n---\n", /must start with/);
  bad("---\nname: a\ndescription: b\n", /not closed/);
  bad("---\nname: a\ndescription: b\n--- \nbody", /not closed/); // a trailing space is not a closing line
  bad("---\n---\nbody", /empty/);
  bad(`---\n${"# c\n".repeat(101)}name: a\n---\n`, /not closed/);
});

test("parse: key:value with no space, a plain value with ' #' or ': ' or a trailing colon, a bad first character", () => {
  bad(doc("name:a\ndescription: b"), /put a space after "name:"/);
  bad(doc("name: a\ndescription: Use this when # not now"), /comment/);
  bad(doc("name: a\ndescription: Use this skill when: the user asks about PDFs"), /quote/);
  bad(doc("name: a\ndescription: ends with a colon:"), /quote/);
  for (const first of ["[x]", "{x}", "&x", "*x", "!x", "%x", "@x", "`x", "-x", "?x", ",x", "#x"]) bad(doc(`name: a\ndescription: ${first}`), /(cannot start with|comment|not a "key)/);
});

test("parse: tabs in the indentation, duplicate keys, forbidden keys", () => {
  bad(doc("name: a\ndescription: >\n\tx"), /tab in the indentation/);
  bad(doc("name: a\nname: b\ndescription: c"), /duplicate key "name"/);
  for (const k of ["__proto__", "constructor", "prototype"]) bad(doc(`name: a\ndescription: b\n${k}: x`), /not allowed/);
  bad(doc("name: a\ndescription: b\nmetadata:\n  constructor: x"), /not allowed/);
  bad(doc("name: a\ndescription: b\nmetadata:\n  k: 1\n  k: 2"), /duplicate metadata key/);
});

test("parse: a value that YAML would not read as a string must be quoted", () => {
  for (const v of ["true", "false", "yes", "no", "null", "~", "123", "1.5", "0x1f", "1e3", "on"]) bad(doc(`name: ${v}\ndescription: b`), /quotes/);
});

test("parse: multi-line plain values, block literals, empty values and block values for other keys", () => {
  bad(doc("name: a\ndescription: first\n  second"), /indented line under a value/);
  bad(doc("name: a\ndescription:\n  indented"), /has no value/);
  bad(doc("name: a\ndescription: |\n  x"), /only allowed for the description, as ">"/);
  bad(doc("name: a\ndescription: b\nlicense: >\n  x"), /only allowed for the description/);
  bad(doc("name: a\ndescription: b\nlicense:"), /has no value/);
});

test("parse: a folded description with a blank line inside, uneven indentation or no lines", () => {
  bad(doc("name: a\ndescription: >\n  one\n\n  two"), /blank line inside/);
  bad(doc("name: a\ndescription: >\n  one\n    two"), /indented the same/);
  bad(doc("name: a\ndescription: >\nlicense: MIT"), /block is empty/);
});

test("parse: bad quotes", () => {
  bad(doc('name: a\ndescription: "unclosed'), /close on the same line/);
  bad(doc("name: a\ndescription: 'unclosed"), /close on the same line/);
  bad(doc('name: a\ndescription: "bad \\n escape"'), /only \\" and \\\\/);
  bad(doc('name: a\ndescription: "x" trailing'), /after the closing quote/);
});

test("parse: metadata must be a map; a flow value is refused; ... and other non-key lines are refused", () => {
  bad(doc("name: a\ndescription: b\nmetadata: {x: 1}"), /must be a map/);
  bad(doc("name: a\ndescription: b\n..."), /not a "key: value" line/);
  bad(doc("name: a\ndescription: b\n- x"), /not a "key: value" line/);
});

test("parse: name and description are required", () => {
  bad(doc("description: b"), /name is required/);
  bad(doc("name: a"), /description is required/);
});

test("parse: a hostile body or huge value does not slow the parser (line by line, no backtracking patterns)", () => {
  const t0 = Date.now();
  parseSkill(doc(`name: a\ndescription: ${"a ".repeat(20_000)}x`, "b ".repeat(100_000)));
  parseSkill(doc(`name: a\ndescription: '${"'".repeat(20_000)}`));
  assert.ok(Date.now() - t0 < 1_000);
});

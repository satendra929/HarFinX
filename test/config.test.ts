import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_OLLAMA_CONTEXT, parseContextLength } from "../src/config.ts";

test("parseContextLength: unset, empty or blank means the default window", () => {
  assert.equal(parseContextLength(undefined), DEFAULT_OLLAMA_CONTEXT);
  assert.equal(parseContextLength(""), DEFAULT_OLLAMA_CONTEXT);
  assert.equal(parseContextLength("   "), DEFAULT_OLLAMA_CONTEXT);
  assert.equal(DEFAULT_OLLAMA_CONTEXT, 16384);
});

test("parseContextLength: a whole number of tokens is taken as written (surrounding spaces allowed)", () => {
  assert.equal(parseContextLength("8192"), 8192);
  assert.equal(parseContextLength(" 32768 "), 32768);
  assert.equal(parseContextLength("2048"), 2048);
  assert.equal(parseContextLength("1048576"), 1_048_576);
});

test("parseContextLength: rejects values that are not a sensible window, and says which variable", () => {
  for (const bad of ["abc", "8k", "8192.5", "-8192", "0", "2047", "1048577", "1e4", "0x2000"]) {
    assert.throws(() => parseContextLength(bad), /OLLAMA_CONTEXT_LENGTH must be a whole number/, bad);
  }
});

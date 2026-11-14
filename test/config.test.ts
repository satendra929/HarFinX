import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_OLLAMA_CONTEXT, isLoopbackUrl, parseContextLength, withoutCredentials } from "../src/config.ts";

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

test("isLoopbackUrl: this machine is local; any other host (a LAN address, a name, a cloud endpoint) is not, and an unreadable URL is not", () => {
  for (const u of ["http://localhost:11434/v1", "http://LOCALHOST:11434", "http://127.0.0.1:11434/v1", "http://127.1.2.3/v1", "http://[::1]:11434/v1", "http://localhost./v1"]) assert.equal(isLoopbackUrl(u), true, u);
  for (const u of ["http://192.168.1.20:11434/v1", "https://api.example.com/v1", "http://my-server:11434", "http://localhost.example.com/v1", "http://127.0.0.1.example.com/v1", "not a url", ""]) assert.equal(isLoopbackUrl(u), false, u);
});

test("withoutCredentials: a user:password part never reaches the audit log; the rest of the URL stays", () => {
  assert.equal(withoutCredentials("http://user:secret@host:11434/v1"), "http://host:11434/v1");
  assert.equal(withoutCredentials("http://token@localhost:11434/v1"), "http://localhost:11434/v1");
  assert.equal(withoutCredentials("http://localhost:11434/v1"), "http://localhost:11434/v1");
  assert.equal(withoutCredentials("nonsense with secret"), "(not a valid URL)");
});

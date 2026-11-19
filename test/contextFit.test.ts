import { test } from "node:test";
import assert from "node:assert/strict";
import { contextMeter, contextWarning, NEAR_LIMIT, promptTokens } from "../src/contextFit.ts";

test("prompt size is the input plus the cached and cache-written parts; missing numbers count as zero", () => {
  assert.equal(promptTokens({ input: 1000, cacheRead: 2000, cacheWrite: 300 }), 3300);
  assert.equal(promptTokens({ input: 5 }), 5);
  assert.equal(promptTokens({}), 0);
  assert.equal(promptTokens(undefined), 0);
});

test("no warning below 95% of the window; a warning at and above it, naming both numbers", () => {
  assert.equal(NEAR_LIMIT, 0.95);
  assert.equal(contextWarning({ input: 7782 }, 8192), undefined); // just under 7782.4
  const w = contextWarning({ input: 7783 }, 8192)!;
  assert.equal(w.used, 7783);
  assert.equal(w.window, 8192);
  assert.match(w.text, /^\[context\] this step's prompt used 7783 of 8192 tokens\./);
  assert.ok(contextWarning({ input: 3000, cacheRead: 5000 }, 8192)); // cached tokens count
  assert.ok(contextWarning({ input: 9000 }, 8192)); // over the window
});

test("an unknown or invalid window never warns", () => {
  assert.equal(contextWarning({ input: 9000 }, 0), undefined);
  assert.equal(contextWarning({ input: 9000 }, NaN), undefined);
  assert.equal(contextWarning({ input: 9000 }, -1), undefined);
  assert.equal(contextWarning(undefined, 8192), undefined);
});

test("contextMeter: how full the conversation is after a question (last prompt plus the reply it wrote)", () => {
  const m = contextMeter({ input: 1000, cacheRead: 5000, output: 500 }, 16384)!;
  assert.equal(m.percent, 40); // 6500 of 16384
  assert.equal(m.high, false);
  assert.equal(m.text, "context 40%");
  assert.equal(contextMeter({ input: 100 }, 1000)!.text, "context 10%"); // no output figure: prompt only
});

test("contextMeter: near the limit it says so, and in chat mode names the way out", () => {
  const near = contextMeter({ input: 15_600 }, 16384)!; // 95.2%
  assert.equal(near.high, true);
  assert.equal(near.text, "context 95%: near the limit");
  assert.equal(contextMeter({ input: 15_600 }, 16384, true)!.text, "context 95%: near the limit; /new starts a fresh conversation");
  assert.equal(contextMeter({ input: 15_500 }, 16384)!.high, false); // 94.6%: under the same 95% line the warning uses
  assert.ok(contextMeter({ input: 20_000 }, 16384)!.percent >= 100); // over the window is shown, not hidden
  assert.equal(contextMeter({ input: 10_000_000 }, 16384)!.percent, 999); // capped so the line stays short
});

test("contextMeter: nothing to show without a usable figure or window", () => {
  assert.equal(contextMeter(undefined, 16384), undefined);
  assert.equal(contextMeter({}, 16384), undefined);
  assert.equal(contextMeter({ input: 0, output: 0 }, 16384), undefined);
  for (const w of [0, -1, NaN]) assert.equal(contextMeter({ input: 100 }, w), undefined);
});

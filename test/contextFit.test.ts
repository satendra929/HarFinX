import { test } from "node:test";
import assert from "node:assert/strict";
import { contextMeter, contextWarning, NEAR_LIMIT, promptTokens } from "../src/contextFit.ts";

test("prompt size is the input plus the cached and cache-written parts; missing numbers count as zero", () => {
  assert.equal(promptTokens({ input: 1000, cacheRead: 2000, cacheWrite: 300 }), 3300);
  assert.equal(promptTokens({ input: 5 }), 5);
  assert.equal(promptTokens({}), 0);
  assert.equal(promptTokens(undefined), 0);
});

test("no warning below 80% of the window; a warning at and above it, naming both numbers", () => {
  assert.equal(NEAR_LIMIT, 0.8);
  assert.equal(contextWarning({ input: 6553 }, 8192), undefined); // just under 6553.6
  const w = contextWarning({ input: 6554 }, 8192)!;
  assert.equal(w.used, 6554);
  assert.equal(w.window, 8192);
  assert.match(w.text, /^\[context\] this step's prompt used 6554 of 8192 tokens\./);
  assert.ok(contextWarning({ input: 3000, cacheRead: 4000 }, 8192)); // cached tokens count
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
  const near = contextMeter({ input: 13_200 }, 16384)!; // 80.6%
  assert.equal(near.high, true);
  assert.equal(near.text, "context 81%: near the limit");
  assert.equal(contextMeter({ input: 13_200 }, 16384, true)!.text, "context 81%: near the limit; /new starts a fresh conversation");
  assert.equal(contextMeter({ input: 13_100 }, 16384)!.high, false); // 79.96%: under the same 80% line the warning uses
  assert.ok(contextMeter({ input: 20_000 }, 16384)!.percent >= 100); // over the window is shown, not hidden
  assert.equal(contextMeter({ input: 10_000_000 }, 16384)!.percent, 999); // capped so the line stays short
});

test("contextMeter: nothing to show without a usable figure or window", () => {
  assert.equal(contextMeter(undefined, 16384), undefined);
  assert.equal(contextMeter({}, 16384), undefined);
  assert.equal(contextMeter({ input: 0, output: 0 }, 16384), undefined);
  for (const w of [0, -1, NaN]) assert.equal(contextMeter({ input: 100 }, w), undefined);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CalcError, D, ENGINE, parseInputLiteral, shownValue, sig12 } from "../src/calc/num.ts";
import { FUNCTIONS, helpText } from "../src/calc/functions.ts";
import { runProgram } from "../src/calc/evaluate.ts";
import { parse } from "../src/calc/parse.ts";

const calc = (expr: string, inputs: Record<string, string> = {}, extra: object = {}) => runProgram(inputs, [{ name: "r", expr, ...extra }]).steps[0];
const val = (expr: string, inputs: Record<string, string> = {}) => calc(expr, inputs).full;
const fails = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof CalcError && re.test(e.message));

test("every function has a definition and known-answer vectors, and they hold", () => {
  assert.ok(FUNCTIONS.length >= 11);
  for (const f of FUNCTIONS) {
    assert.ok(f.definition.length >= 8, `${f.name}: definition`);
    assert.ok(f.vectors.length >= 2, `${f.name}: needs at least 2 vectors`);
    for (const v of f.vectors) assert.equal(sig12(f.run(v.args.map((a) => new D(a)))), v.expect, `${f.name}(${v.args.join(", ")})`);
  }
  assert.match(helpText("cagr"), /\(end \/ begin\)/);
  assert.match(helpText("nope"), /No function/);
});

test("decimal arithmetic is exact where floats are not", () => {
  assert.equal(val("0.1 + 0.2"), "0.3");
  assert.equal(val("1.1 * 1.1"), "1.21");
  assert.equal(val("0.7 + 0.1"), "0.8");
});

test("precedence and associativity", () => {
  assert.equal(val("2 + 3 * 4"), "14");
  assert.equal(val("(2 + 3) * 4"), "20");
  assert.equal(val("2 ^ 3 ^ 2"), "512"); // right associative
  assert.equal(val("-2 ^ 2"), "-4"); // unary minus binds looser than ^
  assert.equal(val("10 - 4 - 3"), "3"); // left associative
  assert.equal(val("8 / 4 / 2"), "1");
});

test("rounding is half away from zero, and only when asked", () => {
  assert.equal(val("round(2.675, 2)"), "2.68");
  assert.equal(val("round(-2.675, 2)"), "-2.68");
  assert.equal(val("round(0.5, 0)"), "1");
  assert.equal(val("round(-0.5, 0)"), "-1");
  // no hidden intermediate rounding: the mean of unrounded margins differs from the mean of rounded ones
  const exact = runProgram({ a: "1306", b: "11503", c: "509", d: "11303", e: "2112", f: "14082" }, [{ name: "m", expr: "avg(a/b, c/d, e/f)", dp: 1, pct: true }]).steps[0];
  assert.equal(exact.shown, "10.3%");
  assert.equal(shownValue(new D("0.103"), undefined, true), "10.3%");
  assert.equal(shownValue(new D("-0.0004"), 2, false), "0.00"); // no negative zero
  assert.equal(shownValue(new D("5818"), undefined, false), "5818");
  assert.equal(shownValue(new D("0.0306"), 2, true), "3.06%");
});

test("input literals: lenient about format, strict about meaning", () => {
  const v = (s: string) => parseInputLiteral(s, "x").toFixed();
  assert.equal(v("11,503"), "11503");
  assert.equal(v("$1,233"), "1233");
  assert.equal(v("(473)"), "-473");
  assert.equal(v("-5.5"), "-5.5");
  assert.equal(v("−7"), "-7");
  assert.equal(v("3.06%"), "0.0306");
  assert.equal(v(" 1,306 "), "1306");
  for (const bad of ["5 million", "5M", "1,23", "abc", "(5", "5)", "1.2.3", "", "1e6", "12 345"]) fails(() => parseInputLiteral(bad, "x"), /cannot read/);
  fails(() => parseInputLiteral("5 million", "x"), /Unit words/);
});

test("errors are clear and name the problem", () => {
  fails(() => calc("1 / 0"), /division by zero/);
  fails(() => calc("a + 1"), /unknown name "a"/);
  fails(() => calc("foo(1)"), /unknown function "foo"/);
  fails(() => calc("1,233 + 1"), /commas are not allowed/);
  assert.equal(val("max(2,10)"), "10"); // commas between arguments are fine
  assert.equal(val("round(2.675,2)"), "2.68");
  fails(() => calc("5m"), /directly after a number/);
  fails(() => calc(""), /empty/);
  fails(() => calc("1 +"), /ends unexpectedly/);
  fails(() => calc("(1 + 2"), /expected "\)"/);
  fails(() => calc("sqrt(-1)"), /negative/);
  fails(() => calc("pow(-8, 0.5)"), /integer exponent/);
  fails(() => calc("ratio(1, 0)"), /zero/);
  fails(() => calc("pct_change(0, 5)"), /zero/);
  fails(() => calc("cagr(0, 5, 2)"), /positive/);
  fails(() => calc("cagr(1, 5, 0)"), /years must be positive/);
  fails(() => calc("avg()"), /argument/);
  fails(() => calc("round(1.5, 20)"), /dp must be/);
  fails(() => calc("10 ^ 1000"), /too large/);
  fails(() => calc("2 ^ 5000"), /limited to 1000/);
  fails(() => calc("1 + 1", {}, { dp: 99 }), /dp must be/);
  fails(() => runProgram({}, []), /at least one step/);
  fails(() => runProgram({ a: "1" }, [{ name: "a", expr: "1" }]), /already used/);
  fails(() => runProgram({ sum: "1" }, [{ name: "r", expr: "1" }]), /function name/);
  fails(() => runProgram({ "1bad": "1" }, [{ name: "r", expr: "1" }]), /must start with a letter/);
});

test("limits: expression length, nesting, tokens, steps, calls", () => {
  fails(() => calc("1+".repeat(300) + "1"), /too long/);
  fails(() => calc("(".repeat(40) + "1" + ")".repeat(40)), /nested too deeply/);
  fails(() => calc("1+1+1+1+1+1+1+1+1+1+".repeat(10) + "1"), /too complex|too long/);
  fails(() => runProgram({}, Array.from({ length: 31 }, (_, i) => ({ name: `s${i}`, expr: "1" }))), /too many steps/);
  assert.equal(runProgram({}, Array.from({ length: 30 }, (_, i) => ({ name: `s${i}`, expr: "1" }))).steps.length, 30);
});

test("later steps can use earlier steps and inputs", () => {
  const r = runProgram({ rev: "11,503", op: "1,306" }, [
    { name: "margin", expr: "op / rev", dp: 2, pct: true },
    { name: "twice", expr: "margin * 2", dp: 1, pct: true },
  ]);
  assert.equal(r.steps[0].shown, "11.35%");
  assert.equal(r.steps[1].shown, "22.7%");
  assert.deepEqual(r.steps[0].calls, []);
  assert.deepEqual(r.steps[0].literals, []);
});

test("hostile names are just unknown names; nothing leaks to or from the JS runtime", () => {
  for (const e of ["constructor", "__proto__", "toString", "hasOwnProperty", "globalThis", "process", "this"]) fails(() => calc(e), /unknown name/);
  fails(() => calc("process.exit()"), /unexpected character/);
  fails(() => calc("constructor(1)"), /unknown function/);
  // an object literal with __proto__ sets the prototype (no own property), so the name is simply unknown
  fails(() => val("__proto__ + 1", { __proto__: "1" } as unknown as Record<string, string>), /unknown name/);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const json = JSON.parse('{"__proto__": "5"}') as Record<string, string>;
  assert.equal(val("__proto__ * 2", json), "10");
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});

test("engine source is deterministic and contains no dynamic code execution", () => {
  const dir = path.join(import.meta.dirname, "..", "src", "calc");
  for (const f of fs.readdirSync(dir)) {
    const code = fs.readFileSync(path.join(dir, f), "utf8").replace(/\/\/.*$/gm, "");
    for (const bad of [/\beval\s*\(/, /new Function/, /\bFunction\s*\(/, /Date\b/, /Math\.random/, /\bprocess\./, /\brequire\s*\(/, /import\s*\(/, /toLocale/, /Intl\./]) {
      assert.doesNotMatch(code, bad, `${f} must not use ${bad}`);
    }
  }
  assert.match(ENGINE, /decimal\.js 10\.6\.0/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "..", "..", "node_modules", "decimal.js", "package.json"), "utf8")).version, "10.6.0");
});

test("same program, same output (determinism)", () => {
  const run = () => JSON.stringify(runProgram({ a: "1,306", b: "11,503" }, [{ name: "m", expr: "a / b", dp: 4, pct: true }, { name: "g", expr: "cagr(100, 150, 3)" }]).steps.map((s) => [s.shown, s.full, s.value.toString()]));
  assert.equal(run(), run());
});

test("parser fuzz: any input either computes or raises a CalcError, quickly", () => {
  let seed = 12345;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  const alphabet = "0123456789+-*/^(),. abxyz_%$é−";
  const t0 = Date.now();
  for (let i = 0; i < 3000; i++) {
    const expr = Array.from({ length: rnd(60) }, () => alphabet[rnd(alphabet.length)]).join("");
    try {
      runProgram({ a: "1", b: "2" }, [{ name: "r", expr }]);
    } catch (e) {
      assert.ok(e instanceof CalcError, `unexpected ${String(e)} for ${JSON.stringify(expr)}`);
    }
  }
  assert.ok(Date.now() - t0 < 5000);
  assert.doesNotThrow(() => parse("a"));
});

// ---- independent cross-check: exact rational arithmetic on BigInt (shares no code with the engine) ----
type Q = { n: bigint; d: bigint };
const gcd = (a: bigint, b: bigint): bigint => {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a || 1n;
};
const norm = (q: Q): Q => {
  if (q.d < 0n) q = { n: -q.n, d: -q.d };
  const g = gcd(q.n, q.d);
  return { n: q.n / g, d: q.d / g };
};
const fromDec = (s: string): Q => {
  const [i, f = ""] = s.split(".");
  return norm({ n: BigInt(i + f), d: 10n ** BigInt(f.length) });
};
const op = {
  "+": (a: Q, b: Q) => norm({ n: a.n * b.d + b.n * a.d, d: a.d * b.d }),
  "-": (a: Q, b: Q) => norm({ n: a.n * b.d - b.n * a.d, d: a.d * b.d }),
  "*": (a: Q, b: Q) => norm({ n: a.n * b.n, d: a.d * b.d }),
  "/": (a: Q, b: Q) => norm({ n: a.n * b.d, d: a.d * b.n }),
};
function refSig12(q: Q): string {
  if (q.n === 0n) return "0";
  const neg = q.n < 0n;
  const n = neg ? -q.n : q.n;
  const pow10 = (e: number) => (e >= 0 ? { n: 10n ** BigInt(e), d: 1n } : { n: 1n, d: 10n ** BigInt(-e) });
  const ge = (a: Q, b: Q) => a.n * b.d >= b.n * a.d;
  let e = 0;
  while (ge({ n, d: q.d }, pow10(e + 1))) e++;
  while (!ge({ n, d: q.d }, pow10(e))) e--;
  const p = 11 - e; // value * 10^p lies in [1e11, 1e12)
  const scaled = op["*"]({ n, d: q.d }, pow10(p));
  const m = (2n * scaled.n + scaled.d) / (2n * scaled.d); // round half up on a positive value
  let digits = m.toString();
  const point = digits.length - p;
  let s: string;
  if (point <= 0) s = "0." + "0".repeat(-point) + digits;
  else if (point >= digits.length) s = digits + "0".repeat(point - digits.length);
  else s = digits.slice(0, point) + "." + digits.slice(point);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return (neg ? "-" : "") + s;
}

test("cross-check: 400 random expressions agree with exact rational arithmetic (12 significant digits)", () => {
  let seed = 987654;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  const leaves = ["12.5", "0.07", "1000", "3.333", "7", "0.5", "250.25", "99.99", "1", "42"];
  type T = { src: string; q: Q } | undefined;
  const gen = (depth: number): T => {
    if (depth === 0 || rnd(4) === 0) {
      const l = leaves[rnd(leaves.length)];
      return { src: l, q: fromDec(l) };
    }
    const o = (["+", "-", "*", "/"] as const)[rnd(4)];
    const a = gen(depth - 1);
    const b = gen(depth - 1);
    if (!a || !b) return undefined;
    if (o === "/" && b.q.n === 0n) return undefined;
    return { src: `(${a.src} ${o} ${b.src})`, q: op[o](a.q, b.q) };
  };
  let checked = 0;
  while (checked < 400) {
    const t = gen(3);
    if (!t) continue;
    assert.equal(val(t.src), refSig12(t.q), t.src);
    checked++;
  }
});

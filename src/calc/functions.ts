// Function library. One entry per function: signature, definition (shown to the model and the user, so the answer
// can state which definition was used), implementation, and known-answer vectors that the tests run.
// Adding a function = adding an entry here with a definition and at least two vectors.
import { CalcError, D, checkFinite, roundHalfAway, type Num } from "./num.ts";

export interface Vector {
  args: string[]; // decimal strings
  expect: string; // result rounded to 12 significant digits, plain notation
}
export interface FnSpec {
  name: string;
  category: "core" | "growth" | "finance";
  sig: string;
  definition: string;
  minArgs: number;
  maxArgs: number;
  run: (a: Num[]) => Num;
  vectors: Vector[];
}

const one = (a: Num[]) => a[0];
const needNonZero = (x: Num, fn: string, what: string) => {
  if (x.isZero()) throw new CalcError(`${fn}: ${what} is zero`);
};
const needPositive = (x: Num, fn: string, what: string) => {
  if (x.lte(0)) throw new CalcError(`${fn}: ${what} must be greater than zero`);
};

export const FUNCTIONS: FnSpec[] = [
  {
    name: "sum", category: "core", sig: "sum(a, b, ...)", definition: "a + b + ...", minArgs: 1, maxArgs: 50,
    run: (a) => a.reduce((s, x) => s.plus(x), new D(0)),
    vectors: [{ args: ["1", "2", "3"], expect: "6" }, { args: ["0.1", "0.2"], expect: "0.3" }],
  },
  {
    name: "avg", category: "core", sig: "avg(a, b, ...)", definition: "arithmetic mean: (a + b + ...) / count", minArgs: 1, maxArgs: 50,
    run: (a) => a.reduce((s, x) => s.plus(x), new D(0)).div(a.length),
    vectors: [{ args: ["1", "2", "3", "4"], expect: "2.5" }, { args: ["11.5", "4.5"], expect: "8" }],
  },
  {
    name: "min", category: "core", sig: "min(a, b, ...)", definition: "smallest argument", minArgs: 1, maxArgs: 50,
    run: (a) => D.min(...a),
    vectors: [{ args: ["3", "1", "2"], expect: "1" }, { args: ["-1", "-5"], expect: "-5" }],
  },
  {
    name: "max", category: "core", sig: "max(a, b, ...)", definition: "largest argument", minArgs: 1, maxArgs: 50,
    run: (a) => D.max(...a),
    vectors: [{ args: ["3", "1", "2"], expect: "3" }, { args: ["-1", "-5"], expect: "-1" }],
  },
  {
    name: "abs", category: "core", sig: "abs(x)", definition: "absolute value", minArgs: 1, maxArgs: 1,
    run: (a) => one(a).abs(),
    vectors: [{ args: ["-5"], expect: "5" }, { args: ["2.5"], expect: "2.5" }],
  },
  {
    name: "round", category: "core", sig: "round(x, dp)", definition: "round x to dp decimal places, ties away from zero (2.5 -> 3, -2.5 -> -3); dp is an integer 0-12", minArgs: 2, maxArgs: 2,
    run: (a) => {
      const dp = a[1].toNumber();
      if (!Number.isInteger(dp) || dp < 0 || dp > 12) throw new CalcError("round: dp must be an integer from 0 to 12");
      return roundHalfAway(a[0], dp);
    },
    vectors: [
      { args: ["2.675", "2"], expect: "2.68" }, { args: ["-2.5", "0"], expect: "-3" },
      { args: ["2.5", "0"], expect: "3" }, { args: ["1.005", "2"], expect: "1.01" },
    ],
  },
  {
    name: "sqrt", category: "core", sig: "sqrt(x)", definition: "square root, x >= 0", minArgs: 1, maxArgs: 1,
    run: (a) => {
      if (one(a).lt(0)) throw new CalcError("sqrt: x is negative");
      return one(a).sqrt();
    },
    vectors: [{ args: ["16"], expect: "4" }, { args: ["2"], expect: "1.41421356237" }],
  },
  {
    name: "pow", category: "core", sig: "pow(x, y)", definition: "x raised to the power y (same as x ^ y); a negative x needs an integer y; |y| <= 1000", minArgs: 2, maxArgs: 2,
    run: (a) => power(a[0], a[1]),
    vectors: [{ args: ["2", "10"], expect: "1024" }, { args: ["1.05", "2"], expect: "1.1025" }, { args: ["9", "0.5"], expect: "3" }],
  },
  {
    name: "ratio", category: "growth", sig: "ratio(a, b)", definition: "a / b, as a fraction (use pct for display as a percent); b must not be zero", minArgs: 2, maxArgs: 2,
    run: (a) => {
      needNonZero(a[1], "ratio", "the divisor (b)");
      return a[0].div(a[1]);
    },
    vectors: [{ args: ["1", "8"], expect: "0.125" }, { args: ["10", "4"], expect: "2.5" }, { args: ["1", "3"], expect: "0.333333333333" }],
  },
  {
    name: "pct_change", category: "growth", sig: "pct_change(old, new)", definition: "(new - old) / |old|, as a fraction; old must not be zero", minArgs: 2, maxArgs: 2,
    run: (a) => {
      needNonZero(a[0], "pct_change", "old");
      return a[1].minus(a[0]).div(a[0].abs());
    },
    vectors: [
      { args: ["100", "120"], expect: "0.2" }, { args: ["120", "100"], expect: "-0.166666666667" },
      { args: ["-100", "-50"], expect: "0.5" },
    ],
  },
  {
    name: "cagr", category: "growth", sig: "cagr(begin, end, years)", definition: "(end / begin) ^ (1 / years) - 1, as a fraction; years = the years between begin and end (2019 to 2023 is 4); begin and end must be positive, years > 0", minArgs: 3, maxArgs: 3,
    run: (a) => {
      // decimal.js isPositive() is true for zero, so compare explicitly
      if (a[0].lte(0) || a[1].lte(0)) throw new CalcError("cagr: begin and end must be positive");
      if (a[2].lte(0)) throw new CalcError("cagr: years must be positive");
      return power(a[1].div(a[0]), new D(1).div(a[2])).minus(1);
    },
    vectors: [{ args: ["100", "121", "2"], expect: "0.1" }, { args: ["1000", "2000", "10"], expect: "0.0717734625363" }],
  },
  // Finance measures with one standard, unambiguous definition. Anything analysts define differently (leverage, interest
  // coverage, returns, turnover, per-share figures, free cash flow) is left to an expression until each variant can be a
  // separate named function: ambiguous metrics get separate names, never flags (decisions.md).
  {
    name: "gross_margin", category: "finance", sig: "gross_margin(gross_profit, revenue)", definition: "gross_profit / revenue, as a fraction (use pct for display as a percent); revenue must be greater than zero", minArgs: 2, maxArgs: 2,
    run: (a) => {
      needPositive(a[1], "gross_margin", "revenue");
      return a[0].div(a[1]);
    },
    vectors: [{ args: ["30", "100"], expect: "0.3" }, { args: ["-5", "50"], expect: "-0.1" }, { args: ["1", "3"], expect: "0.333333333333" }],
  },
  {
    name: "operating_margin", category: "finance", sig: "operating_margin(operating_income, revenue)", definition: "operating_income / revenue, as a fraction (use pct for display as a percent); revenue must be greater than zero", minArgs: 2, maxArgs: 2,
    run: (a) => {
      needPositive(a[1], "operating_margin", "revenue");
      return a[0].div(a[1]);
    },
    vectors: [{ args: ["25", "200"], expect: "0.125" }, { args: ["-10", "80"], expect: "-0.125" }, { args: ["1", "3"], expect: "0.333333333333" }],
  },
  {
    name: "net_margin", category: "finance", sig: "net_margin(net_income, revenue)", definition: "net_income / revenue, as a fraction (use pct for display as a percent); revenue must be greater than zero", minArgs: 2, maxArgs: 2,
    run: (a) => {
      needPositive(a[1], "net_margin", "revenue");
      return a[0].div(a[1]);
    },
    vectors: [{ args: ["15", "60"], expect: "0.25" }, { args: ["-3", "12"], expect: "-0.25" }, { args: ["2", "3"], expect: "0.666666666667" }],
  },
  {
    name: "current_ratio", category: "finance", sig: "current_ratio(current_assets, current_liabilities)", definition: "current_assets / current_liabilities, as a ratio (1.5 means 1.5 to 1); current_liabilities must be greater than zero", minArgs: 2, maxArgs: 2,
    run: (a) => {
      needPositive(a[1], "current_ratio", "current_liabilities");
      return a[0].div(a[1]);
    },
    vectors: [{ args: ["150", "100"], expect: "1.5" }, { args: ["80", "100"], expect: "0.8" }, { args: ["1", "3"], expect: "0.333333333333" }],
  },
  {
    name: "working_capital", category: "finance", sig: "working_capital(current_assets, current_liabilities)", definition: "current_assets - current_liabilities, in the units of the inputs", minArgs: 2, maxArgs: 2,
    run: (a) => a[0].minus(a[1]),
    vectors: [{ args: ["150", "100"], expect: "50" }, { args: ["80", "100"], expect: "-20" }, { args: ["0.5", "0.25"], expect: "0.25" }],
  },
];

export const FUNCTION_MAP: ReadonlyMap<string, FnSpec> = new Map(FUNCTIONS.map((f) => [f.name, f]));
export const CATEGORIES: readonly string[] = [...new Set(FUNCTIONS.map((f) => f.category))];

export function power(base: Num, exp: Num): Num {
  if (exp.abs().gt(1000)) throw new CalcError("power: |exponent| is limited to 1000");
  if (base.isZero() && exp.lt(0)) throw new CalcError("power: zero to a negative power");
  if (base.lt(0) && !exp.isInteger()) throw new CalcError("power: a negative base needs an integer exponent");
  return checkFinite(base.pow(exp), "power");
}

/** Short catalogue for the tool's `help` argument. */
export function helpText(topic?: string): string {
  const t = topic?.trim().toLowerCase();
  const list = t ? FUNCTIONS.filter((f) => f.name === t || f.category === t) : FUNCTIONS;
  if (list.length === 0) return `No function or category "${topic}". Categories: ${CATEGORIES.join(", ")}. Functions: ${FUNCTIONS.map((f) => f.name).join(", ")}.`;
  return list.map((f) => `${f.sig}: ${f.definition}`).join("\n");
}

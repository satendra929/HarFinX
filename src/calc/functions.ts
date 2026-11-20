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
  category: "core" | "growth" | "profit" | "liquidity" | "leverage" | "efficiency" | "returns";
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
const mean2 = (x: Num, y: Num) => x.plus(y).div(2);
const DAYS = 365; // a full year; stated in every day-count definition

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
  // separate named function: ambiguous metrics get separate names, never flags.
  {
    name: "gross_margin", category: "profit", sig: "gross_margin(gross_profit, revenue)", definition: "gross_profit / revenue, as a fraction (use pct for display as a percent); revenue must be greater than zero", minArgs: 2, maxArgs: 2,
    run: (a) => {
      needPositive(a[1], "gross_margin", "revenue");
      return a[0].div(a[1]);
    },
    vectors: [{ args: ["30", "100"], expect: "0.3" }, { args: ["-5", "50"], expect: "-0.1" }, { args: ["1", "3"], expect: "0.333333333333" }],
  },
  {
    name: "operating_margin", category: "profit", sig: "operating_margin(operating_income, revenue)", definition: "operating_income / revenue, as a fraction (use pct for display as a percent); revenue must be greater than zero", minArgs: 2, maxArgs: 2,
    run: (a) => {
      needPositive(a[1], "operating_margin", "revenue");
      return a[0].div(a[1]);
    },
    vectors: [{ args: ["25", "200"], expect: "0.125" }, { args: ["-10", "80"], expect: "-0.125" }, { args: ["1", "3"], expect: "0.333333333333" }],
  },
  {
    name: "net_margin", category: "profit", sig: "net_margin(net_income, revenue)", definition: "net_income / revenue, as a fraction (use pct for display as a percent); revenue must be greater than zero", minArgs: 2, maxArgs: 2,
    run: (a) => {
      needPositive(a[1], "net_margin", "revenue");
      return a[0].div(a[1]);
    },
    vectors: [{ args: ["15", "60"], expect: "0.25" }, { args: ["-3", "12"], expect: "-0.25" }, { args: ["2", "3"], expect: "0.666666666667" }],
  },
  {
    name: "current_ratio", category: "liquidity", sig: "current_ratio(current_assets, current_liabilities)", definition: "current_assets / current_liabilities, as a ratio (1.5 means 1.5 to 1); current_liabilities must be greater than zero", minArgs: 2, maxArgs: 2,
    run: (a) => {
      needPositive(a[1], "current_ratio", "current_liabilities");
      return a[0].div(a[1]);
    },
    vectors: [{ args: ["150", "100"], expect: "1.5" }, { args: ["80", "100"], expect: "0.8" }, { args: ["1", "3"], expect: "0.333333333333" }],
  },
  {
    name: "working_capital", category: "liquidity", sig: "working_capital(current_assets, current_liabilities)", definition: "current_assets - current_liabilities, in the units of the inputs", minArgs: 2, maxArgs: 2,
    run: (a) => a[0].minus(a[1]),
    vectors: [{ args: ["150", "100"], expect: "50" }, { args: ["80", "100"], expect: "-20" }, { args: ["0.5", "0.25"], expect: "0.25" }],
  },
  // Second set. Rules: one definition per name; a variant is a separate name (_ending or _average), never a flag; every
  // argument is a line a filing prints; a flow figure comes before the balance(s); costs and outflows (capital
  // expenditures, depreciation and amortization, interest expense, cost of sales) are taken as absolute values because
  // statements print them with or without brackets.
  {
    name: "effective_tax_rate", category: "profit", sig: "effective_tax_rate(income_tax_expense, pretax_income)", definition: "income_tax_expense / pretax_income, as a fraction (use pct for display as a percent); pretax_income must be greater than zero", minArgs: 2, maxArgs: 2,
    run: (a) => {
      needPositive(a[1], "effective_tax_rate", "pretax_income");
      return a[0].div(a[1]);
    },
    vectors: [{ args: ["1204", "5146"], expect: "0.233968130587" }, { args: ["-50", "200"], expect: "-0.25" }, { args: ["21", "100"], expect: "0.21" }],
  },
  {
    name: "free_cash_flow", category: "profit", sig: "free_cash_flow(operating_cash_flow, capital_expenditures)", definition: "operating_cash_flow - |capital_expenditures|, in the units of the inputs; capital expenditures as printed, with or without brackets", minArgs: 2, maxArgs: 2,
    run: (a) => a[0].minus(a[1].abs()),
    vectors: [{ args: ["38747", "-11323"], expect: "27424" }, { args: ["38747", "11323"], expect: "27424" }, { args: ["-500", "200"], expect: "-700" }],
  },
  {
    name: "ebitda_from_operating_income", category: "profit", sig: "ebitda_from_operating_income(operating_income, depreciation_amortization)", definition: "operating_income + |depreciation_amortization|, in the units of the inputs", minArgs: 2, maxArgs: 2,
    run: (a) => a[0].plus(a[1].abs()),
    vectors: [{ args: ["1306", "412"], expect: "1718" }, { args: ["-100", "250"], expect: "150" }, { args: ["1306", "-412"], expect: "1718" }],
  },
  {
    name: "quick_ratio", category: "liquidity", sig: "quick_ratio(cash_and_equivalents, short_term_investments, receivables, current_liabilities)", definition: "(cash_and_equivalents + short_term_investments + receivables) / current_liabilities, as a ratio; give 0 for a line the balance sheet does not have; current_liabilities must be greater than zero", minArgs: 4, maxArgs: 4,
    run: (a) => {
      needPositive(a[3], "quick_ratio", "current_liabilities");
      return a[0].plus(a[1]).plus(a[2]).div(a[3]);
    },
    vectors: [{ args: ["500", "200", "300", "800"], expect: "1.25" }, { args: ["100", "0", "50", "300"], expect: "0.5" }, { args: ["1", "1", "1", "7"], expect: "0.428571428571" }],
  },
  {
    name: "quick_ratio_ex_inventory", category: "liquidity", sig: "quick_ratio_ex_inventory(current_assets, inventory, current_liabilities)", definition: "(current_assets - inventory) / current_liabilities, as a ratio; current_liabilities must be greater than zero", minArgs: 3, maxArgs: 3,
    run: (a) => {
      needPositive(a[2], "quick_ratio_ex_inventory", "current_liabilities");
      return a[0].minus(a[1]).div(a[2]);
    },
    vectors: [{ args: ["1500", "400", "1000"], expect: "1.1" }, { args: ["900", "0", "1200"], expect: "0.75" }, { args: ["10", "3", "3"], expect: "2.33333333333" }],
  },
  {
    name: "net_debt", category: "leverage", sig: "net_debt(total_debt, cash_and_equivalents)", definition: "total_debt - cash_and_equivalents, in the units of the inputs (negative means net cash)", minArgs: 2, maxArgs: 2,
    run: (a) => a[0].minus(a[1]),
    vectors: [{ args: ["5000", "1200"], expect: "3800" }, { args: ["300", "900"], expect: "-600" }, { args: ["0.5", "0.25"], expect: "0.25" }],
  },
  {
    name: "debt_to_equity", category: "leverage", sig: "debt_to_equity(total_debt, total_equity)", definition: "total_debt / total_equity, as a ratio (debt, not total liabilities); total_equity must be greater than zero", minArgs: 2, maxArgs: 2,
    run: (a) => {
      needPositive(a[1], "debt_to_equity", "total_equity");
      return a[0].div(a[1]);
    },
    vectors: [{ args: ["5000", "4000"], expect: "1.25" }, { args: ["300", "1200"], expect: "0.25" }, { args: ["1", "3"], expect: "0.333333333333" }],
  },
  {
    name: "debt_to_ebitda", category: "leverage", sig: "debt_to_ebitda(total_debt, ebitda)", definition: "total_debt / ebitda, as a multiple; ebitda must be greater than zero", minArgs: 2, maxArgs: 2,
    run: (a) => {
      needPositive(a[1], "debt_to_ebitda", "ebitda");
      return a[0].div(a[1]);
    },
    vectors: [{ args: ["5000", "2000"], expect: "2.5" }, { args: ["300", "1200"], expect: "0.25" }, { args: ["2", "3"], expect: "0.666666666667" }],
  },
  {
    name: "interest_coverage_ebit", category: "leverage", sig: "interest_coverage_ebit(ebit, interest_expense)", definition: "ebit / |interest_expense|, as a multiple (times interest earned); interest_expense must not be zero", minArgs: 2, maxArgs: 2,
    run: (a) => {
      needNonZero(a[1], "interest_coverage_ebit", "interest_expense");
      return a[0].div(a[1].abs());
    },
    vectors: [{ args: ["1306", "-207"], expect: "6.30917874396" }, { args: ["400", "120"], expect: "3.33333333333" }, { args: ["-50", "25"], expect: "-2" }],
  },
  {
    name: "dso_ending", category: "efficiency", sig: "dso_ending(revenue, receivables)", definition: "receivables / revenue * 365, in days; ending receivables and revenue of a full year; revenue must be greater than zero", minArgs: 2, maxArgs: 2,
    run: (a) => {
      needPositive(a[0], "dso_ending", "revenue");
      return a[1].div(a[0]).times(DAYS);
    },
    vectors: [{ args: ["7300", "1000"], expect: "50" }, { args: ["32136", "4210"], expect: "47.8170898681" }, { args: ["3", "1"], expect: "121.666666667" }],
  },
  {
    name: "dso_average", category: "efficiency", sig: "dso_average(revenue, receivables_begin, receivables_end)", definition: "((receivables_begin + receivables_end) / 2) / revenue * 365, in days; revenue of a full year, greater than zero", minArgs: 3, maxArgs: 3,
    run: (a) => {
      needPositive(a[0], "dso_average", "revenue");
      return mean2(a[1], a[2]).div(a[0]).times(DAYS);
    },
    vectors: [{ args: ["7300", "900", "1100"], expect: "50" }, { args: ["32136", "4000", "4210"], expect: "46.624502116" }, { args: ["7", "1", "2"], expect: "78.2142857143" }],
  },
  {
    name: "dio_ending", category: "efficiency", sig: "dio_ending(cost_of_sales, inventory)", definition: "inventory / |cost_of_sales| * 365, in days; ending inventory and cost of sales of a full year; cost_of_sales must not be zero", minArgs: 2, maxArgs: 2,
    run: (a) => {
      needNonZero(a[0], "dio_ending", "cost_of_sales");
      return a[1].div(a[0].abs()).times(DAYS);
    },
    vectors: [{ args: ["3650", "600"], expect: "60" }, { args: ["17136", "4366"], expect: "92.9966153128" }, { args: ["-3650", "600"], expect: "60" }],
  },
  {
    name: "dio_average", category: "efficiency", sig: "dio_average(cost_of_sales, inventory_begin, inventory_end)", definition: "((inventory_begin + inventory_end) / 2) / |cost_of_sales| * 365, in days; cost of sales of a full year, not zero", minArgs: 3, maxArgs: 3,
    run: (a) => {
      needNonZero(a[0], "dio_average", "cost_of_sales");
      return mean2(a[1], a[2]).div(a[0].abs()).times(DAYS);
    },
    vectors: [{ args: ["3650", "500", "700"], expect: "60" }, { args: ["17136", "4034", "4366"], expect: "89.4607843137" }, { args: ["7", "1", "2"], expect: "78.2142857143" }],
  },
  {
    name: "dpo_ending", category: "efficiency", sig: "dpo_ending(cost_of_sales, accounts_payable)", definition: "accounts_payable / |cost_of_sales| * 365, in days (on cost of sales, not purchases); cost of sales of a full year, not zero", minArgs: 2, maxArgs: 2,
    run: (a) => {
      needNonZero(a[0], "dpo_ending", "cost_of_sales");
      return a[1].div(a[0].abs()).times(DAYS);
    },
    vectors: [{ args: ["3650", "450"], expect: "45" }, { args: ["17136", "2266"], expect: "48.2662231559" }, { args: ["-3650", "450"], expect: "45" }],
  },
  {
    name: "dpo_average", category: "efficiency", sig: "dpo_average(cost_of_sales, accounts_payable_begin, accounts_payable_end)", definition: "((accounts_payable_begin + accounts_payable_end) / 2) / |cost_of_sales| * 365, in days (on cost of sales, not purchases); cost of sales of a full year, not zero", minArgs: 3, maxArgs: 3,
    run: (a) => {
      needNonZero(a[0], "dpo_average", "cost_of_sales");
      return mean2(a[1], a[2]).div(a[0].abs()).times(DAYS);
    },
    vectors: [{ args: ["3650", "400", "500"], expect: "45" }, { args: ["17136", "1945", "2266"], expect: "44.8475431839" }, { args: ["7", "1", "2"], expect: "78.2142857143" }],
  },
  {
    name: "inventory_turnover_ending", category: "efficiency", sig: "inventory_turnover_ending(cost_of_sales, inventory)", definition: "|cost_of_sales| / inventory, in turns a year (on cost of sales, not revenue); inventory must be greater than zero", minArgs: 2, maxArgs: 2,
    run: (a) => {
      needPositive(a[1], "inventory_turnover_ending", "inventory");
      return a[0].abs().div(a[1]);
    },
    vectors: [{ args: ["3650", "600"], expect: "6.08333333333" }, { args: ["17136", "4366"], expect: "3.92487402657" }, { args: ["-3650", "600"], expect: "6.08333333333" }],
  },
  {
    name: "inventory_turnover_average", category: "efficiency", sig: "inventory_turnover_average(cost_of_sales, inventory_begin, inventory_end)", definition: "|cost_of_sales| / ((inventory_begin + inventory_end) / 2), in turns a year; the average must be greater than zero", minArgs: 3, maxArgs: 3,
    run: (a) => {
      const avg = mean2(a[1], a[2]);
      needPositive(avg, "inventory_turnover_average", "the average inventory");
      return a[0].abs().div(avg);
    },
    vectors: [{ args: ["3650", "500", "700"], expect: "6.08333333333" }, { args: ["17136", "4034", "4366"], expect: "4.08" }, { args: ["1", "1", "5"], expect: "0.333333333333" }],
  },
  {
    name: "cash_conversion_cycle", category: "efficiency", sig: "cash_conversion_cycle(dso, dio, dpo)", definition: "dso + dio - dpo, in days; use the same variant (ending or average) for all three", minArgs: 3, maxArgs: 3,
    run: (a) => a[0].plus(a[1]).minus(a[2]),
    vectors: [{ args: ["50", "60", "45"], expect: "65" }, { args: ["30.5", "10.25", "80"], expect: "-39.25" }, { args: ["0.1", "0.2", "0.3"], expect: "0" }],
  },
  {
    name: "roa_ending", category: "returns", sig: "roa_ending(net_income, total_assets)", definition: "net_income / total_assets, as a fraction (use pct for display as a percent); ending total assets, greater than zero", minArgs: 2, maxArgs: 2,
    run: (a) => {
      needPositive(a[1], "roa_ending", "total_assets");
      return a[0].div(a[1]);
    },
    vectors: [{ args: ["500", "10000"], expect: "0.05" }, { args: ["-120", "4800"], expect: "-0.025" }, { args: ["1", "3"], expect: "0.333333333333" }],
  },
  {
    name: "roa_average", category: "returns", sig: "roa_average(net_income, total_assets_begin, total_assets_end)", definition: "net_income / ((total_assets_begin + total_assets_end) / 2), as a fraction (use pct for display as a percent); the average must be greater than zero", minArgs: 3, maxArgs: 3,
    run: (a) => {
      const avg = mean2(a[1], a[2]);
      needPositive(avg, "roa_average", "the average total assets");
      return a[0].div(avg);
    },
    vectors: [{ args: ["500", "9000", "11000"], expect: "0.05" }, { args: ["-120", "4600", "5000"], expect: "-0.025" }, { args: ["1", "1", "5"], expect: "0.333333333333" }],
  },
  {
    name: "roe_ending", category: "returns", sig: "roe_ending(net_income, total_equity)", definition: "net_income / total_equity, as a fraction (use pct for display as a percent); ending equity, greater than zero", minArgs: 2, maxArgs: 2,
    run: (a) => {
      needPositive(a[1], "roe_ending", "total_equity");
      return a[0].div(a[1]);
    },
    vectors: [{ args: ["10500", "42000"], expect: "0.25" }, { args: ["-120", "4800"], expect: "-0.025" }, { args: ["1", "3"], expect: "0.333333333333" }],
  },
  {
    name: "roe_average", category: "returns", sig: "roe_average(net_income, total_equity_begin, total_equity_end)", definition: "net_income / ((total_equity_begin + total_equity_end) / 2), as a fraction (use pct for display as a percent); the average must be greater than zero", minArgs: 3, maxArgs: 3,
    run: (a) => {
      const avg = mean2(a[1], a[2]);
      needPositive(avg, "roe_average", "the average total equity");
      return a[0].div(avg);
    },
    vectors: [{ args: ["10500", "35700", "42000"], expect: "0.27027027027" }, { args: ["-120", "4600", "5000"], expect: "-0.025" }, { args: ["1", "1", "5"], expect: "0.333333333333" }],
  },
];

export const FUNCTION_MAP: ReadonlyMap<string, FnSpec> = new Map(FUNCTIONS.map((f) => [f.name, f]));
export const CATEGORIES: readonly string[] = [...new Set(FUNCTIONS.map((f) => f.category))];

/** Names that start with the same word as an unknown name ("dso" -> dso_ending, dso_average). */
export function nearNames(name: string): string[] {
  const word = name.toLowerCase().split("_")[0];
  return word ? FUNCTIONS.map((f) => f.name).filter((n) => n.split("_")[0] === word) : [];
}

export function power(base: Num, exp: Num): Num {
  if (exp.abs().gt(1000)) throw new CalcError("power: |exponent| is limited to 1000");
  if (base.isZero() && exp.lt(0)) throw new CalcError("power: zero to a negative power");
  if (base.lt(0) && !exp.isInteger()) throw new CalcError("power: a negative base needs an integer exponent");
  return checkFinite(base.pow(exp), "power");
}

/** Short catalogue for the tool's `help` argument. */
export function helpText(topic?: string): string {
  const t = topic?.trim().toLowerCase();
  const list = t ? FUNCTIONS.filter((f) => f.name === t || f.category === t || f.name.startsWith(t + "_")) : FUNCTIONS;
  if (list.length === 0) return `No function or category "${topic}". Categories: ${CATEGORIES.join(", ")}. Functions: ${FUNCTIONS.map((f) => f.name).join(", ")}.`;
  return list.map((f) => `${f.sig}: ${f.definition}`).join("\n");
}

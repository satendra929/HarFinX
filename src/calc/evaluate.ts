// Evaluator: inputs -> steps -> results. Deterministic (no clock, no randomness, no locale), bounded, and free of
// object-property lookups: names resolve through Maps, so "constructor" or "__proto__" are just unknown names.
import { FUNCTION_MAP } from "./functions.ts";
import { CalcError, D, checkFinite, displayLossPercent, parseInputLiteral, shownValue, sig12, type Num } from "./num.ts";
import { callsOf, literalsOf, parse, type Node } from "./parse.ts";
import { nearNames, power } from "./functions.ts";

export const RUN_LIMITS = { maxInputs: 60, maxSteps: 30, maxCalls: 100, maxArgs: 50 };

export interface StepInput {
  name: string;
  expr: string;
  dp?: number;
  pct?: boolean;
}
export interface InputResult {
  name: string;
  literal: string;
  value: Num;
}
export interface StepResult {
  name: string;
  expr: string;
  value: Num;
  shown: string;
  full: string; // 12 significant digits, what the model sees besides `shown`
  pct: boolean;
  /** Set when rounding to the requested decimals changed the value by more than 1%: the change, in percent. */
  displayLoss?: string;
  calls: string[];
  literals: string[]; // numeric literals written in the expression
}
export interface RunResult {
  inputs: InputResult[];
  steps: StepResult[];
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

function checkName(name: string, kind: string): void {
  if (typeof name !== "string" || !NAME.test(name)) throw new CalcError(`${kind} name "${String(name).slice(0, 40)}" must start with a letter and use only letters, digits and _ (e.g. net_sales_2019, not 2019_net_sales), at most 40 characters`);
  // A name may equal a function name (a step called `ratio` is natural): the parser tells a call, `ratio(`, from a name.
}

export function runProgram(inputs: Record<string, string>, steps: StepInput[]): RunResult {
  const entries = Object.entries(inputs ?? {});
  if (entries.length > RUN_LIMITS.maxInputs) throw new CalcError(`too many inputs (limit ${RUN_LIMITS.maxInputs})`);
  if (!Array.isArray(steps) || steps.length === 0) throw new CalcError("steps must contain at least one step");
  if (steps.length > RUN_LIMITS.maxSteps) throw new CalcError(`too many steps (limit ${RUN_LIMITS.maxSteps})`);

  const env = new Map<string, Num>();
  const inputResults: InputResult[] = [];
  for (const [name, literal] of entries) {
    checkName(name, "input");
    if (typeof literal !== "string") throw new CalcError(`input "${name}" must be a string copied exactly as printed in the source`);
    const value = parseInputLiteral(literal, name);
    env.set(name, value);
    inputResults.push({ name, literal, value });
  }

  let calls = 0;
  const evalNode = (n: Node, where: string): Num => {
    switch (n.t) {
      case "num":
        return new D(n.v);
      case "name": {
        const v = env.get(n.name);
        if (!v) throw new CalcError(`${where}: unknown name "${n.name}". Available: ${[...env.keys()].join(", ") || "(none)"}`);
        return v;
      }
      case "neg":
        return evalNode(n.x, where).neg();
      case "bin": {
        const l = evalNode(n.l, where);
        const r = evalNode(n.r, where);
        if (n.op === "+") return checkFinite(l.plus(r), where);
        if (n.op === "-") return checkFinite(l.minus(r), where);
        if (n.op === "*") return checkFinite(l.times(r), where);
        if (n.op === "/") {
          if (r.isZero()) throw new CalcError(`${where}: division by zero`);
          return checkFinite(l.div(r), where);
        }
        return power(l, r);
      }
      case "call": {
        const fn = FUNCTION_MAP.get(n.name);
        if (!fn) {
          const near = nearNames(n.name);
          throw new CalcError(`${where}: unknown function "${n.name}". ${near.length ? `Did you mean ${near.join(", ")}? ` : ""}Use help to list functions`);
        }
        if (++calls > RUN_LIMITS.maxCalls) throw new CalcError(`too many function calls (limit ${RUN_LIMITS.maxCalls})`);
        if (n.args.length < fn.minArgs || n.args.length > Math.min(fn.maxArgs, RUN_LIMITS.maxArgs)) {
          throw new CalcError(`${where}: ${fn.sig} takes ${fn.minArgs === fn.maxArgs ? fn.minArgs : `${fn.minArgs} to ${fn.maxArgs}`} argument(s), got ${n.args.length}`);
        }
        return checkFinite(fn.run(n.args.map((a) => evalNode(a, where))), `${where}: ${n.name}`);
      }
    }
  };

  const results: StepResult[] = [];
  for (const [i, s] of steps.entries()) {
    checkName(s?.name, "step");
    if (env.has(s.name)) throw new CalcError(`step name "${s.name}" is already used`);
    if (typeof s.expr !== "string") throw new CalcError(`step "${s.name}": expr must be a string`);
    if (s.dp !== undefined && (!Number.isInteger(s.dp) || s.dp < 0 || s.dp > 12)) throw new CalcError(`step "${s.name}": dp must be an integer from 0 to 12`);
    const tree = parse(s.expr);
    const value = evalNode(tree, `step ${i + 1} "${s.name}"`);
    env.set(s.name, value);
    const pct = s.pct === true;
    results.push({ name: s.name, expr: s.expr, value, shown: shownValue(value, s.dp, pct), full: sig12(value), pct, displayLoss: displayLossPercent(value, s.dp, pct), calls: [...callsOf(tree)], literals: literalsOf(tree) });
  }
  return { inputs: inputResults, steps: results };
}

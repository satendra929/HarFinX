// The calculator tool. Pure function of its arguments: no files, no network, no clock. Every calculated figure in an
// answer should come from here (see src/provenance.ts). Inputs are source numbers copied exactly as printed; the tool
// parses them, computes in exact decimal arithmetic, and returns the values to quote. It reads the ledger only to warn
// about inputs it cannot trace and writes nothing: the engine records the results from `details` (calcOf).
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { CATEGORIES, FUNCTIONS, FUNCTION_MAP, helpText } from "../calc/functions.ts";
import { runProgram, type StepInput } from "../calc/evaluate.ts";
import { parse, timesHundred } from "../calc/parse.ts";
import { CalcError, ENGINE, ROUNDING } from "../calc/num.ts";
import { Ledger, classify, extractNumbers, normalise } from "../provenance.ts";

export type CalcShape = "steps" | "expr";

// Names a function offers in two variants (NAME_ending, NAME_average) are listed once as a stem.
const VARIANT = /^(.+)_(ending|average)$/;
const stems = [...new Set(FUNCTIONS.flatMap((f) => VARIANT.exec(f.name)?.[1] ?? []))];
const FUNCTION_NAMES =
  FUNCTIONS.filter((f) => !VARIANT.test(f.name)).map((f) => f.name).join(", ") +
  `; and ${stems.join(", ")}, each as NAME_ending or NAME_average`;

const COMMON =
  "Exact decimal calculator. Use it for EVERY calculation, ratio, percentage, average, growth rate and unit conversion; never compute in your head. " +
  'Put each number from the source in `inputs` exactly as printed, with a short name that starts with a letter (e.g. {"sales":"11,503","loss":"(473)","rate":"3.06%"}); never type a number you worked out yourself. ' +
  "Expressions may use input names, earlier step names, + - * / ^, parentheses and the functions " + FUNCTION_NAMES + " (ask `help` with a name or a category for definitions and argument order). " +
  "Rates are fractions (0.05); set pct:true to show a percent and dp for the decimal places the question asks for. ";
const EXAMPLE_STEPS = 'Example: inputs {"sales":"11,503","op":"1,306"}, steps [{"name":"margin","expr":"op / sales","dp":1,"pct":true}]. ';
const EXAMPLE_EXPR = 'Example: inputs {"sales":"11,503","op":"1,306"}, expr "op / sales", dp 1, pct true. ';
const QUOTE = "Quote the returned `shown` values exactly.";

const INPUTS_SCHEMA = { type: "object", additionalProperties: { type: "string" }, description: "name -> number copied exactly as printed in the source" };
const HELP_SCHEMA = { type: "string", description: "A function name or category (" + CATEGORIES.join(", ") + ") to list definitions instead of calculating" };

interface Params {
  inputs?: Record<string, string>;
  steps?: StepInput[];
  expr?: string;
  dp?: number;
  pct?: boolean;
  help?: string;
}

/** A calculation as its result's `details` record it: the printed inputs and each step's exact value and shown text. */
export interface CalcRecord {
  inputs: string[];
  /** The inputs with their names, as given (the literals are the same as in `inputs`). */
  named: { name: string; literal: string }[];
  steps: { name: string; expr: string; value: string; shown: string; pct: boolean; calls: string[]; literals: string[] }[];
}

/**
 * The calculation in a calculate result (empty for any other result). The tool only reads the ledger (to warn about
 * inputs it cannot trace); the host records the results in it from here, as it records what a reading tool showed.
 */
export function calcOf(result: unknown): CalcRecord {
  const d = (result as { details?: { inputs?: unknown; steps?: unknown } } | undefined)?.details;
  const given = Array.isArray(d?.inputs) ? d.inputs.filter((i) => typeof i?.literal === "string") : [];
  const inputs = given.map((i) => i.literal as string);
  const named = given.map((i) => ({ name: String(i.name ?? ""), literal: i.literal as string }));
  const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
  const steps = Array.isArray(d?.steps)
    ? d.steps
        .filter((s) => typeof s?.name === "string" && typeof s?.value === "string" && typeof s?.shown === "string")
        .map((s) => ({ name: s.name, expr: typeof s.expr === "string" ? s.expr : "", value: s.value, shown: s.shown, pct: s.pct === true, calls: strings(s.calls), literals: strings(s.literals) }))
    : [];
  return { inputs, named, steps };
}

export function calculateTool(ledger: Ledger, shape: CalcShape = "steps"): AgentTool<any> {
  const parameters =
    shape === "steps"
      ? {
          type: "object",
          properties: {
            inputs: INPUTS_SCHEMA,
            steps: {
              type: "array",
              description: "Evaluated in order; each step may use inputs and earlier steps",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Name for this result" },
                  expr: { type: "string", description: "Expression, e.g. op / sales" },
                  dp: { type: "integer", minimum: 0, maximum: 12, description: "Decimal places to show" },
                  pct: { type: "boolean", description: "Show as a percent (value x 100 with %)" },
                },
                required: ["name", "expr"],
                additionalProperties: false,
              },
            },
            help: HELP_SCHEMA,
          },
          additionalProperties: false,
        }
      : {
          type: "object",
          properties: {
            inputs: INPUTS_SCHEMA,
            expr: { type: "string", description: "Expression using input names, e.g. avg(a/b, c/d) * 100" },
            dp: { type: "integer", minimum: 0, maximum: 12, description: "Decimal places to show" },
            pct: { type: "boolean", description: "Show as a percent (value x 100 with %)" },
            help: HELP_SCHEMA,
          },
          additionalProperties: false,
        };

  return {
    name: "calculate",
    label: "Calculate",
    description: COMMON + (shape === "steps" ? EXAMPLE_STEPS : EXAMPLE_EXPR) + QUOTE,
    parameters,
    executionMode: "sequential", // the ledger must be complete before a calculation is checked against it
    execute: async (_toolCallId, params: Params) => {
      if (typeof params.help === "string") return { content: [{ type: "text", text: helpText(params.help) }], details: { help: params.help } };

      const steps: StepInput[] | undefined = shape === "steps" ? params.steps : typeof params.expr === "string" ? [{ name: "result", expr: params.expr, dp: params.dp, pct: params.pct }] : undefined;
      if (!steps) throw new Error(shape === "steps" ? "give `steps` (or `help`)" : "give `expr` (or `help`)");

      let run;
      try {
        run = runProgram(params.inputs ?? {}, steps);
      } catch (e) {
        if (e instanceof CalcError) throw new Error(e.message); // the model sees the message and can correct itself
        throw e;
      }

      // Provenance of the numbers going in (warn-only for now): each input must appear in the source or the user's message.
      const warnings: string[] = [];
      for (const i of run.inputs) {
        const t = extractNumbers(normalise(i.literal));
        if (t.length === 1 && classify(t[0], ledger).cls === "X") {
          warnings.push(`input "${i.name}" = "${i.literal}" was not found in the file text you have read or in the question. Copy it exactly as printed, or read the file first.`);
        }
      }
      for (const s of run.steps) {
        for (const lit of s.literals) {
          const t = extractNumbers(lit);
          if (t.length === 1 && classify(t[0], ledger).cls === "X") {
            warnings.push(`step "${s.name}": the number ${lit} written in the expression is not from the source or the question; put source numbers in inputs.`);
          }
        }
      }

      // pct:true already shows the value times 100: an expression that multiplies by 100 as well shows a value 100 times too large.
      for (const s of run.steps) {
        let twice = false;
        try {
          twice = s.pct && timesHundred(parse(s.expr));
        } catch {
          twice = false;
        }
        if (twice) warnings.push(`step "${s.name}": pct:true already multiplies by 100 and the expression multiplies by 100 as well, so ${s.shown} is 100 times too large. Do not quote it: remove "* 100" from the expression (or set pct:false), then run it again.`);
      }

      // The displayed value must not be a badly rounded version of the exact one (a rate shown as 0.1 instead of 10.3%).
      for (const s of run.steps) {
        if (s.displayLoss !== undefined) {
          const fix = s.pct ? "use more decimal places in dp" : "use more decimal places in dp, or set pct:true if it is a rate to show as a percent";
          warnings.push(`step "${s.name}": shows ${s.shown} but the exact value is ${s.full}${s.pct ? " (a fraction)" : ""}; rounding changed it by ${s.displayLoss}%. Do not quote ${s.shown}: ${fix}, then run it again.`);
        }
      }

      const lines: string[] = [];
      if (run.inputs.length) lines.push("inputs: " + run.inputs.map((i) => `${i.name} = ${i.value.toFixed()} (from "${i.literal}")`).join("; "));
      for (const s of run.steps) lines.push(`${s.name} = ${s.shown}   [${s.expr} = ${s.full}]`);
      const used = [...new Set(run.steps.flatMap((s) => s.calls))].map((n) => FUNCTION_MAP.get(n)).filter((f) => f !== undefined);
      if (used.length) lines.push("definitions: " + used.map((f) => `${f.sig} = ${f.definition}`).join("; "));
      for (const w of warnings) lines.push(`WARNING: ${w}`);
      lines.push(QUOTE + " Name the definition only if it is not obvious.");

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          engine: ENGINE,
          rounding: ROUNDING,
          inputs: run.inputs.map((i) => ({ name: i.name, literal: i.literal, value: i.value.toString() })),
          steps: run.steps.map((s) => ({ name: s.name, expr: s.expr, value: s.value.toString(), shown: s.shown, pct: s.pct, calls: s.calls, literals: s.literals })),
          warnings,
        },
      };
    },
  };
}

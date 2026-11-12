// The calculator tool. Pure function of its arguments: no files, no network, no clock. Every calculated figure in an
// answer should come from here (see src/provenance.ts). Inputs are source numbers copied exactly as printed; the tool
// parses them, computes in exact decimal arithmetic, and returns the values to quote.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { FUNCTION_MAP, helpText } from "../calc/functions.ts";
import { runProgram, type StepInput } from "../calc/evaluate.ts";
import { CalcError, ENGINE, ROUNDING } from "../calc/num.ts";
import { Ledger, classify, extractNumbers, normalise } from "../provenance.ts";

export type CalcShape = "steps" | "expr";

const COMMON =
  "Exact decimal calculator. Use it for EVERY calculation, ratio, percentage, average, growth rate and unit conversion; never compute in your head. " +
  'Put each number from the source in `inputs` exactly as printed, with a short name that starts with a letter (e.g. {"sales":"11,503","loss":"(473)","rate":"3.06%"}); never type a number you worked out yourself. ' +
  "Expressions may use input names, earlier step names, + - * / ^, parentheses and the functions sum, avg, min, max, abs, round, sqrt, pow, ratio, pct_change, cagr (ask `help` for definitions). " +
  "Rates are fractions (0.05); set pct:true to show a percent and dp for the decimal places the question asks for. ";
const EXAMPLE_STEPS = 'Example: inputs {"sales":"11,503","op":"1,306"}, steps [{"name":"margin","expr":"op / sales","dp":1,"pct":true}]. ';
const EXAMPLE_EXPR = 'Example: inputs {"sales":"11,503","op":"1,306"}, expr "op / sales", dp 1, pct true. ';
const QUOTE = "Quote the returned `shown` values exactly.";

const INPUTS_SCHEMA = { type: "object", additionalProperties: { type: "string" }, description: "name -> number copied exactly as printed in the source" };
const HELP_SCHEMA = { type: "string", description: "A function name or category (core, growth) to list definitions instead of calculating" };

interface Params {
  inputs?: Record<string, string>;
  steps?: StepInput[];
  expr?: string;
  dp?: number;
  pct?: boolean;
  help?: string;
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

      // The displayed value must not be a badly rounded version of the exact one (a rate shown as 0.1 instead of 10.3%).
      for (const s of run.steps) {
        if (s.displayLoss !== undefined) {
          const fix = s.pct ? "use more decimal places in dp" : "use more decimal places in dp, or set pct:true if it is a rate to show as a percent";
          warnings.push(`step "${s.name}": shows ${s.shown} but the exact value is ${s.full}${s.pct ? " (a fraction)" : ""}; rounding changed it by ${s.displayLoss}%. Do not quote ${s.shown}: ${fix}, then run it again.`);
        }
      }

      for (const s of run.steps) ledger.addCalc(s.name, s.value.toString(), s.shown, s.pct);

      const lines: string[] = [];
      if (run.inputs.length) lines.push("inputs: " + run.inputs.map((i) => `${i.name} = ${i.value.toFixed()} (from "${i.literal}")`).join("; "));
      for (const s of run.steps) lines.push(`${s.name} = ${s.shown}   [${s.expr} = ${s.full}]`);
      const used = [...new Set(run.steps.flatMap((s) => s.calls))].map((n) => FUNCTION_MAP.get(n)).filter((f) => f !== undefined);
      if (used.length) lines.push("definitions: " + used.map((f) => `${f.sig} = ${f.definition}`).join("; "));
      for (const w of warnings) lines.push(`WARNING: ${w}`);
      lines.push(QUOTE + " State the definition you used.");

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          engine: ENGINE,
          rounding: ROUNDING,
          inputs: run.inputs.map((i) => ({ name: i.name, literal: i.literal, value: i.value.toString() })),
          steps: run.steps.map((s) => ({ name: s.name, expr: s.expr, value: s.value.toString(), shown: s.shown, pct: s.pct })),
          warnings,
        },
      };
    },
  };
}

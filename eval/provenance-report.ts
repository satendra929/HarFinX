// Offline figure-provenance report: replays a run's audit logs through src/provenance.ts. No live behaviour is
// changed. Source = read_file text the model was shown; user = run_start; C = calculate results; answers = every
// assistant message (all of it was streamed to the user). Usage: npm run eval:provenance -- [run-id]
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../src/workspace.ts";
import { replayProvenance } from "./lib.ts";

const run = process.argv[2] ?? "pilot-1";
const auditRoot = path.join(PROJECT_ROOT, "eval", "runs", run, "audit");
if (!fs.existsSync(auditRoot)) throw new Error(`No audit folder for run "${run}"`);

const lines: string[] = [`# Provenance report: ${run}`, "", "Offline replay of the audit logs. X = number not traceable to the source, the question, a calculation or a known non-figure. X means *not traceable*, not *wrong*.", ""];
const totals: Record<string, number> = { S: 0, U: 0, C: 0, K: 0, X: 0 };
const kReasons: Record<string, number> = {};

for (const id of fs.readdirSync(auditRoot).sort()) {
  const dir = path.join(auditRoot, id);
  const file = fs.readdirSync(dir).find((f) => f.endsWith(".jsonl"));
  if (!file) continue;
  const { checked, counts, unverified } = replayProvenance(fs.readFileSync(path.join(dir, file), "utf8"));
  for (const k of Object.keys(totals)) totals[k] += counts[k as keyof typeof counts];
  for (const c of checked) if (c.cls === "K") kReasons[c.reason] = (kReasons[c.reason] ?? 0) + 1;
  lines.push(`## ${id}: ${checked.length} numbers: S ${counts.S}, U ${counts.U}, C ${counts.C}, K ${counts.K}, **X ${counts.X}**`);
  for (const c of unverified) lines.push(`- X \`${c.token.raw}\`: …${c.context}…`);
  lines.push("");
}

lines.push("## Totals", "", `S ${totals.S}, U ${totals.U}, C ${totals.C}, K ${totals.K}, X ${totals.X}`, "", "K by rule: " + JSON.stringify(kReasons), "");
const out = lines.join("\n");
fs.writeFileSync(path.join(PROJECT_ROOT, "eval", "runs", run, "provenance-report.md"), out, "utf8");
console.log(out);

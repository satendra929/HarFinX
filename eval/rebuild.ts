// Re-renders a run's result files from its audit logs (after the renderer or the checker changed). Refuses to touch a
// file where a human grade has been entered. Usage: npm run eval:rebuild -- <run-id>
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../src/workspace.ts";
import { loadDataset } from "./prepare.ts";
import { parseAuditLog, parseDataset, renderResult, replayProvenance, selectPilot, shortId } from "./lib.ts";

const run = process.argv[2];
if (!run) throw new Error("usage: npm run eval:rebuild -- <run-id>");
const runDir = path.join(PROJECT_ROOT, "eval", "runs", run);
const picked = selectPilot(parseDataset(await loadDataset()));
let n = 0;
for (const rec of picked) {
  const sid = shortId(rec.financebench_id);
  const auditDir = path.join(runDir, "audit", sid);
  const file = fs.existsSync(auditDir) ? fs.readdirSync(auditDir).find((f) => f.endsWith(".jsonl")) : undefined;
  if (!file) continue;
  const target = path.join(runDir, `${sid}.md`);
  if (fs.existsSync(target) && /^human_score:s*S/m.test(fs.readFileSync(target, "utf8"))) {
    console.log(`skip ${sid}: has a human grade`);
    continue;
  }
  const logText = fs.readFileSync(path.join(auditDir, file), "utf8");
  const auditRel = ["eval", "runs", run, "audit", sid, file].join("/");
  fs.writeFileSync(target, renderResult({ rec, runId: run, summary: parseAuditLog(logText), provenance: replayProvenance(logText), auditRelPath: auditRel }), "utf8");
  n++;
}
console.log(`rebuilt ${n} result file(s) in eval/runs/${run}/`);

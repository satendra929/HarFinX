// FinanceBench pilot, part 1 (prepare): pick the questions and write their evidence files into the workspace.
// Gold answers are NOT written there (the model could read them); run.ts reads them from eval/data/.
// Usage: npm run eval:prepare
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { ensureWorkspaceDir, openWorkspace, PROJECT_ROOT } from "../src/workspace.ts";
import { DATASET_SHA256, DATASET_URL, evidenceFileText, evidencePath, parseDataset, selectPilot, sha256Hex } from "./lib.ts";

export const DATASET_FILE = path.join(PROJECT_ROOT, "eval", "data", "financebench_open_source.jsonl");

/** Read the pinned dataset (downloading it once if missing) and verify its hash. */
export async function loadDataset(): Promise<string> {
  if (!fs.existsSync(DATASET_FILE)) {
    console.log(`Downloading the pinned FinanceBench open sample (public file)…`);
    const res = await fetch(DATASET_URL);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    fs.mkdirSync(path.dirname(DATASET_FILE), { recursive: true });
    fs.writeFileSync(DATASET_FILE, Buffer.from(await res.arrayBuffer()));
  }
  const raw = fs.readFileSync(DATASET_FILE);
  const hash = sha256Hex(raw);
  if (hash !== DATASET_SHA256) throw new Error(`dataset hash mismatch (got ${hash}); delete eval/data/ and retry`);
  return raw.toString("utf8");
}

async function main(): Promise<void> {
  const picked = selectPilot(parseDataset(await loadDataset()));
  const cfg = loadConfig();
  ensureWorkspaceDir(cfg.workspaceDir);
  const ws = openWorkspace(cfg.workspaceDir);
  const dir = path.join(ws.root, "eval");
  fs.mkdirSync(dir, { recursive: true });
  for (const rec of picked) {
    // Written by a dev script, not by the agent: the agent only ever reads these through read_file.
    fs.writeFileSync(path.join(ws.root, evidencePath(rec.financebench_id)), evidenceFileText(rec), "utf8");
  }
  console.log(`Wrote ${picked.length} evidence files to ${path.relative(PROJECT_ROOT, dir) || dir}${path.sep}`);
  for (const r of picked) {
    const chars = r.evidence[0].evidence_text.length;
    console.log(`  ${r.financebench_id}  ${r.company.padEnd(16)} ${r.question_type.padEnd(18)} ${String(chars).padStart(5)} chars`);
  }
}

// Run only when executed directly, so tests and run.ts can import loadDataset without side effects.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

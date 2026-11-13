// FinanceBench pilot, part 2 (run): run each selected question through the harness, one at a time, and write
// one result file per question plus a manifest. Results come from each run's audit log only (never from stdout
// or the exit code). Local Ollama models only: evidence passages must not go to a cloud provider.
// Usage: npm run eval:run -- [--mode evidence|page|doc] [--set pilot|filings5|all] [--limit N] [--ids 03029,03030]
//          [--run-id name] [--trials N] [--timeout-min 10] [--download]
// Each run gets its own staged workspace (eval/data/workspaces/<run-id>) holding only what the mode needs: the evidence
// files (evidence mode) or the filing PDFs (page mode). Filings are downloaded from the dataset repository at the
// pinned commit (npm run eval:filings); --download lets this runner fetch a missing one.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { DEFAULT_LIMITS } from "../src/guard.ts";
import { PROJECT_ROOT } from "../src/workspace.ts";
import { loadDataset } from "./prepare.ts";
import { ensurePdf, questionSet } from "./filings.ts";
import {
  DATASET_COMMIT,
  DATASET_SHA256,
  MODES,
  PROMPT_TEMPLATES,
  buildPrompt,
  evidenceFileText,
  evidencePath,
  goldPages,
  hashFiles,
  parseAuditLog,
  pdfPath,
  pdfUrl,
  replayProvenance,
  parseDataset,
  renderResult,
  selectPilot,
  sha256Hex,
  shortId,
  type FbRecord,
  type Mode,
} from "./lib.ts";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const rel = (...p: string[]) => p.join("/"); // repo-relative, forward slashes (no absolute paths in results)

function srcHash(): string {
  const entries: [string, Buffer][] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".ts")) entries.push([path.relative(PROJECT_ROOT, full).replace(/\\/g, "/"), fs.readFileSync(full)]);
    }
  };
  walk(path.join(PROJECT_ROOT, "src"));
  return hashFiles(entries);
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: PROJECT_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function modelDigest(baseUrl: string, model: string): Promise<string> {
  try {
    const res = await fetch(new URL("/api/tags", baseUrl).href, { signal: AbortSignal.timeout(5000) });
    const tags = (await res.json()) as { models?: { name: string; digest: string }[] };
    return tags.models?.find((m) => m.name === model)?.digest ?? "not found";
  } catch {
    return "unknown (Ollama not reachable)";
  }
}

/** Spawn the CLI directly (no npm/cmd wrapper, no shell), so the question is one intact argument and a kill really stops it. */
function runOne(prompt: string, auditDirRel: string, workspaceRel: string, timeoutMs: number): Promise<{ timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", prompt], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, AUDIT_DIR: auditDirRel, WORKSPACE_DIR: workspaceRel }, // one audit folder per question, one staged workspace per run; .env never overrides a set variable
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    child.stderr.resume(); // drain so the child cannot block; never stored (it can contain absolute paths)
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve({ timedOut });
    };
    child.on("close", done);
    child.on("error", done);
  });
}

/** A clean workspace for one run, holding only what the mode needs. Returns its repo-relative path and the PDF hashes. */
async function stageWorkspace(runId: string, mode: Mode, picked: FbRecord[], allowDownload: boolean): Promise<{ workspaceRel: string; pdfs: Record<string, string> }> {
  const workspaceRel = rel("eval", "data", "workspaces", runId);
  const dir = path.join(PROJECT_ROOT, workspaceRel);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const pdfs: Record<string, string> = {};
  if (mode === "evidence") {
    for (const rec of picked) {
      const target = path.join(dir, evidencePath(rec.financebench_id));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, evidenceFileText(rec), "utf8"); // written by this script; the agent only reads it through read_file
    }
  } else {
    for (const doc of [...new Set(picked.map((r) => r.doc_name))].sort()) {
      const source = await ensurePdf(doc, () => allowDownload);
      const target = path.join(dir, pdfPath({ doc_name: doc } as FbRecord));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      pdfs[doc] = sha256Hex(fs.readFileSync(target));
    }
  }
  return { workspaceRel, pdfs };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.provider !== "ollama") throw new Error("The eval runs local Ollama models only (PROVIDER=ollama).");

  const mode = (arg("mode") ?? "evidence") as Mode;
  if (!MODES.includes(mode)) throw new Error("--mode must be evidence, page or doc");
  const set = arg("set") ?? "pilot";
  if (set !== "pilot" && set !== "filings5" && set !== "all") throw new Error("--set must be pilot, filings5 or all");
  const rows = parseDataset(await loadDataset());
  let picked = set === "pilot" ? selectPilot(rows) : questionSet(rows, set);
  const ids = arg("ids")?.split(",").map((s) => s.trim());
  if (ids) picked = picked.filter((r) => ids.includes(shortId(r.financebench_id)));
  const limit = Number(arg("limit") ?? picked.length);
  picked = picked.slice(0, limit);
  if (picked.length === 0) throw new Error("No questions selected.");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runId = arg("run-id") ?? `run-${stamp}`;
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error("--run-id may contain only letters, digits, . _ -");
  const runDir = path.join(PROJECT_ROOT, "eval", "runs", runId);
  if (fs.existsSync(runDir)) throw new Error(`Run folder already exists: ${rel("eval", "runs", runId)} (never overwritten)`);
  fs.mkdirSync(runDir, { recursive: true });
  const timeoutMs = Number(arg("timeout-min") ?? 10) * 60_000;
  const trials = Math.max(1, Number(arg("trials") ?? 1));

  const { workspaceRel, pdfs } = await stageWorkspace(runId, mode, picked, process.argv.includes("--download"));
  const unpdfVersion = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")).dependencies?.unpdf ?? "none";

  const manifest = {
    runId,
    mode:
      mode === "evidence"
        ? "evidence-provided: gold evidence snippet given as a file; n=" + picked.length
        : mode === "page"
          ? "page: the whole filing as a PDF, the gold PDF page named in the question; n=" + picked.length
          : "doc: the whole filing as a PDF named in the question; the model has to find the page; n=" + picked.length,
    set,
    workspace: workspaceRel,
    pdfSha256: pdfs,
    pdfReader: mode === "evidence" ? "n/a" : `unpdf ${unpdfVersion}`,
    startedAt: new Date().toISOString(),
    git: { commit: git(["rev-parse", "HEAD"]), uncommittedChanges: git(["status", "--porcelain"]) !== "" },
    srcSha256: srcHash(),
    dataset: { upstreamCommit: DATASET_COMMIT, sha256: DATASET_SHA256 },
    promptTemplate: PROMPT_TEMPLATES[mode],
    model: { provider: cfg.provider, name: cfg.ollamaModel, digest: await modelDigest(cfg.ollamaBaseUrl, cfg.ollamaModel) },
    sampling: "model/Ollama defaults (the harness sets no temperature or seed)",
    limits: DEFAULT_LIMITS,
    timeoutMinutes: timeoutMs / 60_000,
    node: process.version,
    note: "The first question also pays the model load time.",
    trials,
    calcShape: process.env.CALC_SHAPE ?? "steps (default)",
    questions: picked.map((r) => r.financebench_id),
  };
  fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Run ${runId}: ${picked.length} question(s) x ${trials} trial(s), model ${cfg.ollamaModel}, timeout ${manifest.timeoutMinutes} min each`);

  const outcomes: Record<string, number> = {};
  const jobs = picked.flatMap((rec) => Array.from({ length: trials }, (_, k) => ({ rec, k })));
  for (const [i, { rec, k }] of jobs.entries()) {
    const sid = trials === 1 ? shortId(rec.financebench_id) : `${shortId(rec.financebench_id)}-t${k + 1}`;
    const auditDirRel = rel("eval", "runs", runId, "audit", sid);
    const t0 = Date.now();
    const { timedOut } = await runOne(buildPrompt(rec, mode), auditDirRel, workspaceRel, timeoutMs);

    const auditDir = path.join(PROJECT_ROOT, auditDirRel);
    const file = fs.existsSync(auditDir) ? fs.readdirSync(auditDir).find((f) => f.endsWith(".jsonl")) : undefined;
    const logText = file ? fs.readFileSync(path.join(auditDir, file), "utf8") : undefined;
    const summary = logText ? parseAuditLog(logText) : undefined;
    const provenance = logText ? replayProvenance(logText) : undefined;
    const note = timedOut ? `killed after ${manifest.timeoutMinutes} min` : !file ? "no audit log produced (startup failure?)" : undefined;
    fs.writeFileSync(
      path.join(runDir, `${sid}.md`),
      renderResult({ rec, runId, summary, provenance, auditRelPath: file ? rel(auditDirRel, file) : undefined, note, mode }),
      "utf8",
    );

    const outcome = summary?.outcome ?? "no_audit_log";
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    console.log(
      `[${i + 1}/${jobs.length}] ${sid}  ${outcome}  ${((Date.now() - t0) / 1000).toFixed(0)}s  tools=${summary?.toolCalls.length ?? 0} calc=${summary?.calcCalls ?? 0} X=${provenance?.counts.X ?? "?"}` +
        (mode !== "evidence" && summary ? `  gold-page ${goldPages(rec).some((g) => summary.pagesRead.some((r) => r.page === g)) ? "read" : "NOT read"}` : "") +
        (summary && !summary.hasAnswer ? "  NO ANSWER" : "") +
        (summary?.contextFlag ? "  CONTEXT?" : ""),
    );
  }
  console.log(`Done. Outcomes: ${JSON.stringify(outcomes)}`);
  console.log(`Results: ${rel("eval", "runs", runId)}/ (one .md per question + manifest.json)`);
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

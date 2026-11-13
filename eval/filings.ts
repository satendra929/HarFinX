// FinanceBench filings: download the filing PDFs the questions are about, once, into the git-ignored eval/data/pdfs/.
// Public filings from the dataset repository at the pinned commit (non-commercial dataset licence: they stay out of git).
// Usage: npm run eval:filings -- [--set all|filings5] [--check]
//   --check  only report what is missing; download nothing
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../src/workspace.ts";
import { loadDataset } from "./prepare.ts";
import { FILINGS5, parseDataset, pdfUrl, selectByDocs, selectSingleEvidence, sha256Hex, type FbRecord } from "./lib.ts";

export const PDF_DIR = path.join(PROJECT_ROOT, "eval", "data", "pdfs");

/** The filing PDF for a document name, downloaded once. `allowed` limits what may be fetched (the five set up first). */
export async function ensurePdf(doc: string, allowed: (doc: string) => boolean = () => true): Promise<string> {
  const file = path.join(PDF_DIR, `${doc}.pdf`);
  if (fs.existsSync(file)) return file;
  if (!allowed(doc)) throw new Error(`The filing ${doc} is not downloaded. Run: npm run eval:filings -- --set all`);
  const res = await fetch(pdfUrl(doc), { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`download of ${doc} failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error(`${doc}: the download is not a PDF`);
  fs.mkdirSync(PDF_DIR, { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

export function questionSet(rows: FbRecord[], set: string): FbRecord[] {
  if (set === "all") return selectSingleEvidence(rows);
  if (set === "filings5") return selectByDocs(rows, FILINGS5);
  throw new Error("--set must be all or filings5");
}

async function main(): Promise<void> {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const records = questionSet(parseDataset(await loadDataset()), arg("set") ?? "all");
  const docs = [...new Set(records.map((r) => r.doc_name))].sort();
  const missing = docs.filter((d) => !fs.existsSync(path.join(PDF_DIR, `${d}.pdf`)));
  console.log(`${records.length} questions on ${docs.length} filings; ${missing.length} not downloaded yet`);
  if (process.argv.includes("--check")) {
    for (const d of missing) console.log(`  missing: ${d}`);
    return;
  }
  let done = 0;
  for (const doc of missing) {
    try {
      await ensurePdf(doc);
      done++;
      console.log(`[${done}/${missing.length}] ${doc}`);
    } catch (err) {
      console.log(`[failed] ${doc}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const manifest: Record<string, { bytes: number; sha256: string }> = {};
  for (const d of docs) {
    const f = path.join(PDF_DIR, `${d}.pdf`);
    if (fs.existsSync(f)) {
      const b = fs.readFileSync(f);
      manifest[d] = { bytes: b.length, sha256: sha256Hex(b) };
    }
  }
  fs.writeFileSync(path.join(PDF_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const total = Object.values(manifest).reduce((a, m) => a + m.bytes, 0);
  console.log(`${Object.keys(manifest).length} of ${docs.length} filings on disk (${(total / 1e6).toFixed(0)} MB); hashes in eval/data/pdfs/manifest.json`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

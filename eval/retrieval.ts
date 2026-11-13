// Retrieval check, no model: does page search put the gold page in the top results?
// Runs the same search the agent's `search` tool uses over the filings in eval/data/pdfs/, for questions whose gold
// evidence page is known, with different kinds of query:
//   raw     the question text as written (the floor: the agent normally writes a shorter query)
//   clean   the question after the tool's query cleaning (src/documents/query.ts)
//   label   a query made of the row labels printed in the gold evidence (what a good model query looks like;
//           derived automatically, so it is a regression guard, not a tuned set)
// Usage: npm run eval:retrieval -- [--set all|filings5] [--list]   (filings: npm run eval:filings first)
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../src/workspace.ts";
import { parsePdf } from "../src/documents/pdf.ts";
import { buildIndex, type PageIndex } from "../src/documents/search.ts";
import { cleanQuery } from "../src/documents/query.ts";
import { goldPages, parseDataset, type FbRecord } from "./lib.ts";
import { questionSet } from "./filings.ts";
import { loadDataset } from "./prepare.ts";

/** Row labels printed in the evidence text: the words before the first number on each line. */
export function labelQuery(evidenceText: string, maxWords = 16): string {
  const labels: string[] = [];
  for (const line of evidenceText.split("\n")) {
    const label = line.split(/[$(\d]/)[0].replace(/[^A-Za-z&' -]/g, " ").replace(/\s+/g, " ").trim();
    if (/[A-Za-z]{3}/.test(label) && !labels.includes(label)) labels.push(label);
  }
  return labels.join(" ").split(" ").slice(0, maxWords).join(" ");
}

export interface Probe {
  id: string;
  doc: string;
  ranks: { raw: number; clean: number; label: number }; // Infinity = not in the top 20
}

function rankOf(index: PageIndex, query: string, gold: number[]): number {
  const hits = index.search(query, 20);
  const i = hits.findIndex((h) => gold.includes(h.page));
  return i < 0 ? Infinity : i + 1;
}

export async function runProbe(records: FbRecord[], pdfDir = path.join(PROJECT_ROOT, "eval", "data", "pdfs")): Promise<{ probes: Probe[]; failed: { doc: string; reason: string }[] }> {
  const indexes = new Map<string, PageIndex>();
  const failed: { doc: string; reason: string }[] = [];
  for (const doc of new Set(records.map((r) => r.doc_name))) {
    try {
      indexes.set(doc, buildIndex((await parsePdf(fs.readFileSync(path.join(pdfDir, `${doc}.pdf`)))).pages));
    } catch (err) {
      failed.push({ doc, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  const probes = records
    .filter((r) => indexes.has(r.doc_name))
    .map((r): Probe => {
      const index = indexes.get(r.doc_name)!;
      const gold = goldPages(r);
      return {
        id: r.financebench_id.slice(-5),
        doc: r.doc_name,
        ranks: {
          raw: rankOf(index, r.question, gold),
          clean: rankOf(index, cleanQuery(r.question), gold),
          label: rankOf(index, labelQuery(r.evidence[0].evidence_text), gold),
        },
      };
    });
  return { probes, failed };
}

export const recallAt = (probes: Probe[], kind: "raw" | "clean" | "label", k: number): number => probes.filter((p) => p.ranks[kind] <= k).length;

async function main(): Promise<void> {
  const set = process.argv.includes("--set") ? process.argv[process.argv.indexOf("--set") + 1] : "all";
  const records = questionSet(parseDataset(await loadDataset()), set);
  const { probes, failed } = await runProbe(records);
  console.log(`questions: ${probes.length} of ${records.length} (gold page = the one page of the dataset evidence; other valid pages are not credited)`);
  for (const f of failed) console.log(`  could not read ${f.doc}: ${f.reason}`);
  console.log("query set | recall@1 @3 @5 @10 @20");
  for (const kind of ["raw", "clean", "label"] as const) {
    console.log(`${kind.padEnd(9)} | ${[1, 3, 5, 10, 20].map((k) => String(recallAt(probes, kind, k)).padStart(3)).join(" ")}`);
  }
  if (process.argv.includes("--list")) {
    const shown = (n: number) => (n === Infinity ? ">20" : String(n)).padStart(3);
    for (const p of probes) console.log(`${p.id} ${p.doc.slice(0, 22).padEnd(22)} raw ${shown(p.ranks.raw)}  clean ${shown(p.ranks.clean)}  label ${shown(p.ranks.label)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

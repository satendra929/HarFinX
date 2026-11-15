// Search replay, no model: re-ranks the queries a model actually typed in earlier doc-mode runs and reports where the gold
// page lands under different search variants. It cannot say what a model would do with a different list; it only says
// whether the page is in view. Usage: npm run eval:replay -- <run> [<run> ...]   (the runs' result files, eval/runs/<run>/)
//
// Guard against fitting the data: the held-out group is fixed here, before any number is read: the companies are sorted by
// name and every third one (positions 2, 5, 8, ...) is held out. Nothing in a variant is tuned; the held-out group and the
// per-company table show whether a gain is spread or comes from a few filings.
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../src/workspace.ts";
import { parsePdf } from "../src/documents/pdf.ts";
import { buildIndex, type PageHit, type PageIndex } from "../src/documents/search.ts";
import { cleanQuery } from "../src/documents/query.ts";
import { goldPages, parseDataset } from "./lib.ts";
import { questionSet } from "./filings.ts";
import { loadDataset } from "./prepare.ts";

/** The cleaner as it was before the colon rule: the first sentence always stays. */
export function legacyCleanQuery(query: string): string {
  const INSTRUCTION = /^(?:if|answer|respond|please|assume|state|explain|provide|round|express|note|consider|give|show|use|then)\b/i;
  const MARKERS = [/\b(?:FY|CY)\s?'?\d{2,4}\b/gi, /\bQ[1-4]\s?'?\d{2,4}\b/gi, /\b[1-4]Q\s?'?\d{2,4}\b/gi, /\b(?:19|20)\d{2}\b/g];
  const text = query.replace(/\s+/g, " ").trim();
  const sentences = text.split(/(?<=[.?!])\s+/);
  let cleaned = sentences.filter((s, i) => i === 0 || !INSTRUCTION.test(s)).join(" ");
  for (const marker of MARKERS) cleaned = cleaned.replace(marker, " ");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return /[A-Za-z]{3}/.test(cleaned) ? cleaned : text;
}


/** The published default of reciprocal rank fusion (Cormack et al., 2009); not tuned here. */
const RRF_K = 60;

/** Merges rankings of the same pages: each page scores the sum of 1 / (RRF_K + rank) over the lists that have it. */
export function fuseHits(lists: readonly PageHit[][]): PageHit[] {
  const score = new Map<number, number>();
  const first = new Map<number, PageHit>();
  const order = new Map<number, number>();
  lists.forEach((list) =>
    list.forEach((h, i) => {
      score.set(h.page, (score.get(h.page) ?? 0) + 1 / (RRF_K + i + 1));
      if (!first.has(h.page)) {
        first.set(h.page, h);
        order.set(h.page, order.size);
      }
    }),
  );
  return [...first.values()].map((h) => ({ ...h, score: score.get(h.page)! })).sort((a, b) => b.score - a.score || order.get(a.page)! - order.get(b.page)! || a.page - b.page);
}

/** The typed query's first `top` pages stay; the pages after them alternate between the question's ranking (not shown yet, question first) and the typed continuation. */
export function backfillHits(typed: readonly PageHit[], fromQuestion: readonly PageHit[], top: number, depth: number): PageHit[] {
  const out = typed.slice(0, top);
  const shown = new Set(out.map((h) => h.page));
  const more = fromQuestion.filter((h) => !shown.has(h.page));
  const rest = typed.slice(top);
  for (let i = 0; out.length < depth && (i < more.length || i < rest.length); i++) {
    for (const h of [more[i], rest[i]]) if (h && !shown.has(h.page) && out.length < depth) (shown.add(h.page), out.push(h));
  }
  return out;
}

const DEPTH = 20;
const MAX_QUERY_CHARS = 200;
const TOP = 5;
export const VARIANTS = ["base", "clean", "fuse", "fill"] as const;
export type Variant = (typeof VARIANTS)[number];

/** Pages in rank order for one typed query under a variant (what `search` would rank, before it shows five at a time). */
export function rankPages(index: PageIndex, variant: Variant, typed: string, question: string): number[] {
  const t = typed.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
  if (variant === "base") return index.search(legacyCleanQuery(t), DEPTH).map((h) => h.page);
  const cleaned = cleanQuery(t);
  const typedHits = index.search(cleaned, DEPTH);
  if (variant === "clean") return typedHits.map((h) => h.page);
  const q = cleanQuery(question).slice(0, MAX_QUERY_CHARS).trim();
  const other: PageHit[] = q && q !== cleaned ? index.search(q, DEPTH) : [];
  if (variant === "fuse") return (other.length ? fuseHits([typedHits, other]) : typedHits).map((h) => h.page);
  return backfillHits(typedHits, other, TOP, DEPTH).map((h) => h.page);
}

export const rankOfGold = (pages: number[], gold: number[]): number => {
  const i = pages.findIndex((p) => gold.includes(p));
  return i < 0 ? Infinity : i + 1;
};

export const heldOutCompanies = (companies: string[]): Set<string> => new Set([...new Set(companies)].sort().filter((_, i) => i % 3 === 2));

/** Two-sided exact sign test p-value for `wins` against `losses` (ties left out). */
export function signTest(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.min(wins, losses);
  let p = 0;
  let c = 1; // C(n, i)
  for (let i = 0; i <= k; i++) {
    p += c;
    c = (c * (n - i)) / (i + 1);
  }
  return Math.min(1, (2 * p) / 2 ** n);
}

interface Case {
  run: string;
  id: string;
  company: string;
  held: boolean;
  length: number; // characters of the cleaned question
  ranks: Record<Variant, number>;
}

async function main(): Promise<void> {
  const runs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (runs.length === 0) throw new Error("usage: npm run eval:replay -- <run> [<run> ...]");
  const records = questionSet(parseDataset(await loadDataset()), "all");
  const held = heldOutCompanies(records.map((r) => r.company));
  const indexes = new Map<string, PageIndex>();
  const cases: Case[] = [];
  for (const run of runs) {
    for (const r of records) {
      const id = r.financebench_id.slice(-5);
      const file = path.join(PROJECT_ROOT, "eval", "runs", run, `${id}.md`);
      if (!fs.existsSync(file)) continue;
      const queries = [...new Set([...(/^search_queries: (.*)$/m.exec(fs.readFileSync(file, "utf8"))?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]))];
      if (queries.length === 0) continue;
      if (!indexes.has(r.doc_name)) indexes.set(r.doc_name, buildIndex((await parsePdf(fs.readFileSync(path.join(PROJECT_ROOT, "eval", "data", "pdfs", `${r.doc_name}.pdf`)))).pages));
      const index = indexes.get(r.doc_name)!;
      const gold = goldPages(r);
      for (const q of queries) {
        const ranks = Object.fromEntries(VARIANTS.map((v) => [v, rankOfGold(rankPages(index, v, q, r.question), gold)])) as Record<Variant, number>;
        cases.push({ run, id, company: r.company, held: held.has(r.company), length: cleanQuery(r.question).length, ranks });
      }
    }
  }
  const at = (cs: Case[], v: Variant, k: number) => cs.filter((c) => c.ranks[v] <= k).length;
  const row = (label: string, cs: Case[]) => {
    const cells = VARIANTS.map((v) => [1, 3, 5, 10].map((k) => String(at(cs, v, k)).padStart(3)).join(" "));
    console.log(`${label.padEnd(26)} n=${String(cs.length).padStart(3)} | ${cells.join(" | ")}`);
  };
  console.log(`runs: ${runs.join(", ")}; cases (one per typed query): ${cases.length}; held-out companies: ${[...held].sort().join(", ")}`);
  console.log(`${"".padEnd(26)}        | ${VARIANTS.map((v) => v.padEnd(15)).join(" | ")}   (gold page in top 1 / 3 / 5 / 10 of the ranking)`);
  row("all", cases);
  row("held-out companies", cases.filter((c) => c.held));
  row("other companies", cases.filter((c) => !c.held));
  const sorted = [...cases].sort((a, b) => a.length - b.length);
  const third = Math.ceil(sorted.length / 3);
  [["short questions", sorted.slice(0, third)], ["medium questions", sorted.slice(third, 2 * third)], ["long questions", sorted.slice(2 * third)]].forEach(([l, cs]) => row(`${l} (${(cs as Case[])[0]?.length}-${(cs as Case[]).at(-1)?.length} chars)`, cs as Case[]));
  console.log("\npaired change in the top 5 against base (gold in the top 5: gained / lost), sign test p:");
  for (const v of ["clean", "fuse"] as const) {
    for (const [label, cs] of [["all", cases], ["held-out", cases.filter((c) => c.held)]] as const) {
      const gained = cs.filter((c) => c.ranks[v] <= 5 && c.ranks.base > 5).length;
      const lost = cs.filter((c) => c.ranks[v] > 5 && c.ranks.base <= 5).length;
      console.log(`  ${v.padEnd(5)} ${label.padEnd(8)} +${gained} -${lost}  p=${signTest(gained, lost).toFixed(3)}`);
    }
  }
  console.log("\npaired change in the top 10 against base (a model that also asks for the next five): gained / lost, sign test p:");
  for (const v of ["fuse", "fill"] as const) {
    for (const [label, cs] of [["all", cases], ["held-out", cases.filter((c) => c.held)]] as const) {
      const gained = cs.filter((c) => c.ranks[v] <= 10 && c.ranks.base > 10).length;
      const lost = cs.filter((c) => c.ranks[v] > 10 && c.ranks.base <= 10).length;
      console.log(`  ${v.padEnd(5)} ${label.padEnd(8)} +${gained} -${lost}  p=${signTest(gained, lost).toFixed(3)}`);
    }
  }
  console.log("\nper company, gold in the top 10 (base -> fill), cases:");
  for (const company of [...new Set(cases.map((c) => c.company))].sort()) {
    const cs = cases.filter((c) => c.company === company);
    const a = at(cs, "base", 10);
    const b = at(cs, "fill", 10);
    console.log(`  ${company.padEnd(22)} ${held.has(company) ? "held-out" : "        "} ${String(a).padStart(3)} -> ${String(b).padStart(3)} of ${String(cs.length).padStart(3)}${b < a ? "   DROP" : ""}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

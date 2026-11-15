// Statement extraction check, no model, over the 10-K and 10-Q PDFs in eval/data/pdfs/ (the names are test labels only).
//  1. identities: does the balance sheet balance and does closing cash tie, per document?
//  2. concepts: for each of the standard concepts, how many documents give found / ambiguous / not found?
//  3. fidelity: for the questions whose gold page is a primary statement, do the extracted rows of that page hold only
//     numbers that the dataset's own evidence text also holds (an independent text of the same page)?
// Usage: npx tsx eval/statementsCheck.ts [--list]
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../src/workspace.ts";
import { parsePdf } from "../src/documents/pdf.ts";
import { classifyDocument, supportsStatements } from "../src/documents/kind.ts";
import { CONCEPTS, candidatesFor } from "../src/documents/concepts.ts";
import { extractStatements, type StatementPage } from "../src/documents/statements.ts";
import { checkStatements } from "../src/documents/statementChecks.ts";
import { goldPages, parseDataset } from "./lib.ts";
import { questionSet } from "./filings.ts";
import { loadDataset } from "./prepare.ts";

async function main(): Promise<void> {
  const list = process.argv.includes("--list");
  const dir = path.join(PROJECT_ROOT, "eval", "data", "pdfs");
  const docs = new Map<string, { pages: string[]; st: StatementPage[] }>();
  for (const f of fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith(".pdf"))) {
    const pages = (await parsePdf(fs.readFileSync(path.join(dir, f)))).pages;
    if (!supportsStatements(classifyDocument(pages))) continue;
    docs.set(f.replace(/\.pdf$/i, ""), { pages, st: extractStatements(pages) });
  }
  console.log(`documents the statement tools apply to: ${docs.size}`);

  // 1. identities
  const tally = { balance: { verified: 0, failed: 0, not_checked: 0 }, cash: { verified: 0, failed: 0, not_checked: 0 } };
  for (const [name, d] of docs) {
    const r = checkStatements(d.st);
    tally.balance[r.balance.status]++;
    tally.cash[r.cash.status]++;
    if (list && (r.balance.status !== "verified" || r.cash.status !== "verified")) console.log(`  ${name}: balance ${r.balance.status} (${r.balance.detail.slice(0, 90)}); cash ${r.cash.status} (${r.cash.detail.slice(0, 90)})`);
  }
  console.log(`\n1. identities (documents): balance sheet ${JSON.stringify(tally.balance)}; closing cash ${JSON.stringify(tally.cash)}`);

  // 2. concept coverage
  console.log("\n2. concepts (documents: found / ambiguous / not found / row misaligned)");
  for (const c of CONCEPTS) {
    let found = 0, amb = 0, none = 0, bad = 0;
    const odd: string[] = [];
    for (const [name, d] of docs) {
      const r = candidatesFor(c, d.st);
      const distinct = new Set(r.found.map((x) => `${x.page.page}:${x.row.line}`));
      if (distinct.size === 1) found++;
      else if (distinct.size > 1) (amb++, odd.push(`${name} (${[...distinct].join(", ")})`));
      else (r.misaligned ? bad++ : none++);
    }
    console.log(`  ${c.id.padEnd(26)} ${String(found).padStart(3)} / ${String(amb).padStart(3)} / ${String(none).padStart(3)} / ${bad}`);
    if (list && amb) console.log(`      ambiguous: ${odd.slice(0, 6).join("; ")}`);
  }

  // 3. fidelity against the dataset's evidence text
  const recs = questionSet(parseDataset(await loadDataset()), "all");
  let pagesChecked = 0, rowsChecked = 0, rowsClean = 0;
  const dirty: string[] = [];
  const numsOf = (t: string) => new Set((t.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, "")));
  for (const r of recs) {
    const d = docs.get(r.doc_name);
    if (!d) continue;
    for (const g of goldPages(r)) {
      const sp = d.st.find((s) => s.page === g);
      if (!sp) continue;
      const evidence = numsOf(r.evidence.map((e) => e.evidence_text).join("\n"));
      pagesChecked++;
      for (const row of sp.rows.filter((x) => x.aligned)) {
        const nums = row.values.filter((v): v is string => v !== null && v !== "0").map((v) => v.replace(/^-/, "")); // a printed dash is "0" and has no digits in the evidence
        if (nums.length === 0) continue;
        // only rows the evidence text covers at all (the evidence is an excerpt of the page): at least one number in common
        if (!nums.some((n) => evidence.has(n))) continue;
        rowsChecked++;
        if (nums.every((n) => evidence.has(n))) rowsClean++;
        else dirty.push(`${r.doc_name} p.${g}: ${row.label.slice(0, 40)} -> ${row.values.join(" ; ")}`);
      }
    }
  }
  console.log(`\n3. fidelity: ${pagesChecked} statement gold pages; of ${rowsChecked} extracted rows that the evidence text shares a number with, ${rowsClean} hold only numbers the evidence text holds`);
  if (list) for (const d of dirty.slice(0, 20)) console.log("   differs: " + d);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Document-kind check, no model: runs the detector (src/documents/kind.ts) over every PDF in eval/data/pdfs/ and compares
// it with the form the FILE NAME gives (_10K, _10Q, _8K, _EARNINGS). The names are test labels only: the product never reads them.
// Usage: npx tsx eval/kindCheck.ts [--signals]
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../src/workspace.ts";
import { parsePdf } from "../src/documents/pdf.ts";
import { classifyDocument, supportsStatements, type Form } from "../src/documents/kind.ts";

export const labelOf = (file: string): Form => (/_10K(?![A-Za-z0-9])|_10-K/i.test(file) ? "10-K" : /_10Q(?![A-Za-z0-9])|_10-Q/i.test(file) ? "10-Q" : /_8K(?![A-Za-z0-9])/i.test(file) ? "8-K" : /EARNINGS/i.test(file) ? "earnings" : "unknown");

async function main(): Promise<void> {
  const dir = path.join(PROJECT_ROOT, "eval", "data", "pdfs");
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf")).sort();
  const rows: { file: string; want: Form; got: ReturnType<typeof classifyDocument> }[] = [];
  for (const f of files) {
    try {
      rows.push({ file: f, want: labelOf(f), got: classifyDocument((await parsePdf(fs.readFileSync(path.join(dir, f)))).pages) });
    } catch (err) {
      console.log(`${f}: unreadable (${err instanceof Error ? err.message : err})`);
    }
  }
  const forms: Form[] = ["10-K", "10-Q", "8-K", "earnings"];
  console.log("label      n | called right (high / medium) | called unknown | called another form");
  for (const w of forms) {
    const rs = rows.filter((r) => r.want === w);
    const right = rs.filter((r) => r.got.form === w);
    const unknown = rs.filter((r) => r.got.form === "unknown");
    const wrong = rs.filter((r) => r.got.form !== w && r.got.form !== "unknown");
    console.log(`${w.padEnd(9)} ${String(rs.length).padStart(2)} | ${String(right.length).padStart(2)} (${right.filter((r) => r.got.confidence === "high").length} / ${right.filter((r) => r.got.confidence === "medium").length}) | ${unknown.length} | ${wrong.length}`);
    for (const r of [...unknown, ...wrong]) console.log(`    ${r.file}: ${r.got.form}/${r.got.confidence} score ${r.got.score}${process.argv.includes("--signals") ? "\n      " + r.got.signals.join("\n      ") : ""}`);
  }
  const wrongHigh = rows.filter((r) => r.got.confidence === "high" && r.got.form !== r.want);
  console.log(`\nwrong with HIGH confidence: ${wrongHigh.length}${wrongHigh.length ? " -> " + wrongHigh.map((r) => r.file).join(", ") : ""}`);
  console.log(`statement tools would apply to ${rows.filter((r) => supportsStatements(r.got)).length} of ${rows.length} files; wrongly applied to non-10-K/10-Q files: ${rows.filter((r) => supportsStatements(r.got) && r.want !== "10-K" && r.want !== "10-Q").length}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

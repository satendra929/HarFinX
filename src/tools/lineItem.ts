// Read-only tool: one line item of a primary statement (balance sheet, income statement, cash flow statement) of a 10-K or
// 10-Q PDF, taken from the typed rows (src/documents/statements.ts) instead of from reading a page. It answers found,
// ambiguous or not_found, and says why; it never guesses a row, a period or a scope. When it cannot answer, the model
// searches and reads pages as before. What it shows is the row exactly as printed, and the ledger gets that row, so the
// figure is traced and referenced like a figure read from a page.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { DocStore } from "../documents/store.ts";
import type { ParsedPdf } from "../documents/pdf.ts";
import { classifyDocument, supportsStatements, type DocKind } from "../documents/kind.ts";
import { CONCEPT_IDS, CONCEPTS, candidatesFor, conceptById, type Candidate } from "../documents/concepts.ts";
import { extractStatements, type Column, type StatementPage } from "../documents/statements.ts";
import { checkStatements, type CheckResult } from "../documents/statementChecks.ts";
import { printedLabelOf } from "../documents/printed.ts";
import type { PageVisits } from "../documents/visits.ts";
import { shownContent, type ShownText } from "../shown.ts";

interface Prepared {
  kind: DocKind;
  statements: StatementPage[];
  checks: CheckResult;
}

const MAX_AMBIGUOUS = 4;
const YEAR = /(?:19|20)\d\d/;

/** The columns a period asks for: [] when none fits, several when the question is not specific enough. */
export function pickColumns(columns: readonly Column[], period: string | undefined): { picked: Column[]; note?: string } {
  const p = (period ?? "").trim();
  if (!p) return { picked: [...columns], note: "no period given: every printed column is shown" };
  const year = YEAR.exec(p)?.[0];
  if (!year) return { picked: [...columns], note: "no year in the period: every printed column is shown" };
  let m = columns.filter((c) => c.year === year);
  if (m.length > 1) {
    const quarter = /three months|quarter|13 weeks|\bq[1-4]\b/i.test(p);
    const ytd = /six months|nine months|year to date|ytd|26 weeks|39 weeks|half/i.test(p);
    const annual = /annual|fiscal year|full year|twelve|\bfy\b|year ended/i.test(p) && !quarter && !ytd;
    const narrowed = m.filter((c) => (quarter ? /three months|quarter|13 weeks/i.test(c.heading) : ytd ? /six months|nine months|26 weeks|39 weeks/i.test(c.heading) : annual ? !/months|weeks/i.test(c.heading) : true));
    if (narrowed.length > 0) m = narrowed;
  }
  return { picked: m };
}

const same = (a: Candidate, b: Candidate) => a.page.page === b.page.page && a.row.line === b.row.line;

export function lineItemTool(docs: DocStore, visits?: PageVisits): AgentTool<any> {
  const prepared = new WeakMap<ParsedPdf, Prepared>();
  const prepare = (doc: ParsedPdf): Prepared => {
    let p = prepared.get(doc);
    if (!p) {
      const kind = classifyDocument(doc.pages);
      const statements = supportsStatements(kind) ? extractStatements(doc.pages) : [];
      p = { kind, statements, checks: checkStatements(statements) };
      prepared.set(doc, p);
    }
    return p;
  };
  return {
    name: "get_line_item",
    label: "Get line item",
    description:
      "Look up one line of a primary statement in a 10-K or 10-Q PDF, as printed, without reading pages: " +
      `concept is one of ${CONCEPT_IDS.join(", ")}; period is optional (a year such as 2022, with "three months", "six months" or "annual" when a quarterly report prints several). ` +
      "Answers found, ambiguous or not_found with the reason; when it is not found, use search and read_page. Use it first for a figure on the balance sheet, income statement or cash flow statement.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "PDF file path relative to the workspace" },
        concept: { type: "string", enum: CONCEPT_IDS, description: "Which line" },
        period: { type: "string", description: "Optional: the period asked for, for example 2022, or 'three months 2023'" },
      },
      required: ["path", "concept"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params: { path: string; concept: string; period?: string }, signal) => {
      if (typeof params.path !== "string" || !/\.pdf$/i.test(params.path)) throw new Error("get_line_item reads PDF files");
      const doc = await docs.pdf(params.path, signal);
      const prep = prepare(doc);
      const head = (status: string, concept = params.concept) => `[get_line_item ${concept} in ${params.path}: ${status}]`;
      const out = (text: string, details: Record<string, unknown>, shown: ShownText[] = []) => ({
        content: [{ type: "text" as const, text }],
        details: { path: params.path, concept: params.concept, period: params.period ?? null, ...details },
        ...(shown.length ? { structuredContent: shownContent(shown) } : {}),
      });
      const notFound = (reason: string, extra: Record<string, unknown> = {}) =>
        out(`${head("not_found")}\n${reason}\n[use search and read_page to find it]`, { status: "not_found", reason, ...extra });

      if (!supportsStatements(prep.kind)) {
        return notFound(`this file does not read as an annual or quarterly report that this tool supports (looks like: ${prep.kind.form}, ${prep.kind.confidence} confidence)`, { kind: prep.kind.form });
      }
      const def = conceptById(String(params.concept ?? ""));
      if (!def) return notFound(`unknown concept; choose one of: ${CONCEPTS.map((c) => c.id).join(", ")}`);

      const { found, misaligned } = candidatesFor(def, prep.statements);
      if (found.length === 0) {
        const have = [...new Set(prep.statements.map((s) => s.id))];
        return notFound(
          have.includes(def.statement)
            ? `no row on the ${def.statement.toLowerCase()} is labelled like ${def.title.toLowerCase()}${misaligned ? ` (${misaligned} row${misaligned === 1 ? "" : "s"} with that label had cells that do not line up with the columns and were not used)` : ""}`
            : `the ${def.statement.toLowerCase()} was not found in this file`,
        );
      }

      const rows: Candidate[] = [];
      for (const c of found) if (!rows.some((r) => same(r, c))) rows.push(c);
      const shownOf = (cs: Candidate[]): ShownText[] =>
        cs.map((c) => ({ label: `${params.path} p.${c.page.page}`, text: c.row.text, meta: { file: params.path, page: c.page.page, pageLines: c.page.lines, lineOffset: c.row.line, printed: printedLabelOf(doc.pages, c.page.page) } }));
      const checkLine = (): string => {
        const { balance, cash } = prep.checks;
        const parts = [`balance sheet: ${balance.status === "verified" ? balance.detail : balance.status === "failed" ? "DOES NOT BALANCE (" + balance.detail + ")" : "not checked"}`, `closing cash: ${cash.status === "verified" ? cash.detail : cash.status === "failed" ? "DOES NOT TIE (" + cash.detail + ")" : "not compared"}`];
        return `[checks: ${parts.join("; ")}]`;
      };
      const unverified = prep.checks.balance.status === "failed" || prep.checks.cash.status === "failed";
      const describe = (c: Candidate) => `${c.page.id}, page ${c.page.page}${c.page.units ? `, ${c.page.units}` : ""}\n  Columns: ${c.page.columns.map((x) => x.heading).join(" | ")}\n  Row as printed: ${c.row.text}`;

      if (rows.length > 1) {
        const shown = rows.slice(0, MAX_AMBIGUOUS);
        visits?.opened(params.path, shown[0].page.page, "passage");
        const text = `${head("ambiguous")}\n${rows.length} rows fit ${def.title.toLowerCase()}; which one is meant is not decided here (different scope or lines):\n${shown.map((c, i) => `${i + 1}. ${describe(c)}`).join("\n")}\n[read the page with read_page to decide]`;
        return out(text, { status: "ambiguous", rows: shown.map((c) => ({ page: c.page.page, line: c.row.line })) }, shownOf(shown));
      }

      const c = rows[0];
      const { picked, note } = pickColumns(c.page.columns, params.period);
      if (picked.length === 0) {
        return notFound(`the ${c.page.id.toLowerCase()} on page ${c.page.page} prints no column for ${params.period}; its columns are: ${c.page.columns.map((x) => x.heading).join(" | ")}`, { page: c.page.page });
      }
      visits?.opened(params.path, c.page.page, "passage");
      const status = unverified ? "found, UNVERIFIED" : "found";
      if (picked.length > 1 && params.period && YEAR.test(params.period)) {
        // several columns share the year (a quarterly report prints three and six months): the period must say which
        const text = `${head("ambiguous")}\nmore than one column fits ${params.period}: ${picked.map((x) => x.heading).join(" | ")}\n${describe(c)}\n[say "three months" or "six months" (or annual), or read the page with read_page]`;
        return out(text, { status: "ambiguous", page: c.page.page, columns: picked.map((x) => x.heading) }, shownOf([c]));
      }
      const selected = picked.length === c.page.columns.length ? "" : `\nColumn asked for: ${picked[0].heading} -> ${c.row.cells[picked[0].index]}`;
      const text = `${head(status)}\n${describe(c)}${selected}${note ? `\n[${note}]` : ""}\n${checkLine()}${unverified ? "\n[the statements do not pass an accounting check: confirm on the page]" : ""}`;
      return out(text, { status: unverified ? "unverified" : "found", page: c.page.page, line: c.row.line, column: picked.length === 1 && note === undefined ? picked[0].index : null }, shownOf([c]));
    },
  };
}

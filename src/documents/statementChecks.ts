// Two accounting identities that catch most extraction mistakes, run over the extracted statements. Pure: no I/O.
// A failed check never changes a number: it only marks the statements "unverified" so a result says so.
//   balance sheet: total assets equal total liabilities and equity, column by column;
//   cash: the cash flow statement's closing cash equals the balance sheet's cash (or cash with restricted cash), same year.
import { CONCEPTS, candidatesFor, normLabel } from "./concepts.ts";
import type { StatementPage } from "./statements.ts";

export type CheckStatus = "verified" | "failed" | "not_checked";
export interface CheckResult {
  balance: { status: CheckStatus; detail: string };
  cash: { status: CheckStatus; detail: string };
}

const close = (a: string, b: string): boolean => Math.abs(Number(a) - Number(b)) <= 1; // rounding at the printed scale

export function checkStatements(pages: readonly StatementPage[]): CheckResult {
  return { balance: checkBalance(pages), cash: checkCash(pages) };
}

function checkBalance(pages: readonly StatementPage[]): CheckResult["balance"] {
  let compared = 0;
  const bad: string[] = [];
  for (const p of pages.filter((x) => x.id === "Balance sheet")) {
    const assets = p.rows.find((r) => r.aligned && normLabel(r.label) === "total assets");
    const both = p.rows.find((r) => r.aligned && /^total liabilities and /.test(normLabel(r.label)));
    if (!assets || !both) continue;
    p.columns.forEach((c, i) => {
      const a = assets.values[i];
      const b = both.values[i];
      if (a === null || b === null) return;
      compared++;
      if (!close(a, b)) bad.push(`p.${p.page} ${c.heading}: assets ${a}, liabilities and equity ${b}`);
    });
  }
  if (compared === 0) return { status: "not_checked", detail: "no total assets and total liabilities and equity pair found" };
  return bad.length ? { status: "failed", detail: bad.join("; ") } : { status: "verified", detail: `total assets equal total liabilities and equity in ${compared} column${compared === 1 ? "" : "s"}` };
}

function checkCash(pages: readonly StatementPage[]): CheckResult["cash"] {
  const bs = CONCEPTS.find((c) => c.id === "cash")!;
  const cash = candidatesFor(bs, pages).found;
  const withRestricted = pages.filter((p) => p.id === "Balance sheet").flatMap((p) => p.rows.filter((r) => r.aligned && /^cash.*restricted cash$/.test(normLabel(r.label))).map((row) => ({ page: p, row })));
  const bsByYear = new Map<string, string[]>();
  // Only the current period is compared: the balance sheet of a quarter holds no balance for the same date a year earlier.
  for (const c of [...cash, ...withRestricted]) {
    const col = c.page.columns[0];
    if (col?.year && c.row.values[0] !== null) bsByYear.set(col.year, [...(bsByYear.get(col.year) ?? []), c.row.values[0]!]);
  }
  let compared = 0;
  const bad: string[] = [];
  for (const p of pages.filter((x) => x.id === "Cash flow statement")) {
    const end = p.rows.find((r) => r.aligned && /^cash.*(?:end of (?:the )?(?:year|period)|ending)/.test(normLabel(r.label)) || (r.aligned && /^cash .*end$/.test(normLabel(r.label))));
    if (!end) continue;
    p.columns.slice(0, 1).forEach((col, i) => {
      const v = end.values[i];
      const options = col.year ? bsByYear.get(col.year) : undefined;
      if (v === null || !options) return;
      const ties = options.some((o) => close(o, v));
      // Closing cash that includes restricted cash (or customer funds) need not equal the balance sheet's "cash and cash equivalents"
      // when the balance sheet does not print that total: that is not a failure, so it is not compared.
      if (!ties && /restricted|customer/.test(normLabel(end.label))) return;
      compared++;
      if (!ties) bad.push(`p.${p.page} ${col.heading}: closing cash ${v}, balance sheet ${options.join(" or ")}`);
    });
  }
  if (compared === 0) return { status: "not_checked", detail: "no closing cash row matched a balance sheet year" };
  return bad.length ? { status: "failed", detail: bad.join("; ") } : { status: "verified", detail: `closing cash ties to the balance sheet in ${compared} column${compared === 1 ? "" : "s"}` };
}

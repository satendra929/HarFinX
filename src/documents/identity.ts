// Which filing is this file? Company, form and period end, read from the cover of a PDF (its first pages), so that with
// several filings in a folder the model can tell them apart whatever the files are called (the file name is never read).
//
// Every rule here comes from what the SEC prescribes for a cover, never from how some file happened to look:
//   - a heading line "FORM 10-K" and a title phrase ("Annual report pursuant to Section 13 or 15(d)"), read by kind.ts;
//   - the period on the heading block's own line ("For the fiscal year ended <date>"), before the file number;
//   - the registrant's name on the line between the file number and the state / IRS block ("(Exact name of registrant ...)"
//     is the label that follows it, when the filer prints one).
// Every part is optional: when the cover is not clear the part is left out, never guessed (a wrong company is worse than
// none). The cover is untrusted text that ends up in the model's prompt, so the only free text is the company, capped and
// cleaned; the period is a date matched by pattern and the form one of a fixed set. Pure: no I/O.
import { classifyDocument, type Form } from "./kind.ts";

export interface FileIdentity {
  form?: Form;
  /** The form is an amendment (10-K/A): often only some parts of the report, so it is said. */
  amendment?: boolean;
  company?: string;
  /** "December 31, 2022": the period a 10-K or 10-Q covers, or the date of an 8-K. */
  periodEnd?: string;
}

/** Pages of a PDF that identity reads. */
export const COVER_PAGES = 3;
const COMPANY_MAX = 60;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DATE = new RegExp(`(${MONTHS.join("|")})\\s+(\\d{1,2}),?\\s+((?:19|20)\\d\\d)`, "i");
// The words that introduce the period on a cover; the date is the first one after them (a table may put other words between).
const PERIOD_HEAD: Record<string, RegExp> = {
  "10-K": /\b(?:fiscal\s+)?year\s+ended\b/i,
  "10-Q": /\b(?:quarterly\s+period|period|quarter)\s+ended\b/i,
  "8-K": /\bdate\s+of\s+report\b/i,
};
const FORM_HEADING = /^\W*FORM\s+\d/i;
const AMENDMENT = /^\W*FORM\s+(?:10-K|10-Q|8-K)\s*\/\s*A\b/i;
const TITLE_PHRASE = /(?:annual|quarterly|current)\s+report/i;
const REGISTRANT_LABEL = /exact\s+name\s+of\s+(?:each\s+)?registrant/i;
const FILE_NUMBER = /commission\s+file\s+n(?:umber|o)/i;
// The block the cover prints after the name: state of incorporation, IRS employer number.
const STATE_OR_ID = /\d{2}-\d{7}|state\s+(?:of|or)\b|incorporation|jurisdiction/i;

const clean = (s: string): string => s.replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
const dateOf = (text: string): string | undefined => {
  const m = DATE.exec(text);
  const month = m && MONTHS.find((x) => x.toLowerCase() === m[1].toLowerCase());
  return m && month ? `${month} ${Number(m[2])}, ${m[3]}` : undefined;
};

/** Could this line be a company name? Shape only: short, has letters, is not parenthesised, a "label: value" line, the file number line, or a run of digits (dates, ZIP and IRS numbers). */
function nameLike(line: string | undefined): line is string {
  return !!line && line.length <= COMPANY_MAX && !/^\(|:/.test(line) && !FILE_NUMBER.test(line) && (line.match(/\p{L}/gu) ?? []).length >= 3 && (line.match(/\d/g) ?? []).length < 4;
}

/**
 * The registrant's name: the one line between the file number and the state / IRS block (or the label printed under the
 * name). It is accepted only when it stands alone: a name-like line right above it means the name may run over two lines
 * or that something else is printed there, and no company is shown.
 */
function companyOf(lines: readonly string[]): string | undefined {
  const labels = lines.flatMap((l, i) => (REGISTRANT_LABEL.test(l) ? [i] : []));
  if (labels.length > 1) return undefined; // several registrants: not one company
  const fileNo = lines.findIndex((l) => FILE_NUMBER.test(l));
  let end: number | undefined = labels[0]; // the line the name sits directly above
  if (end === undefined && fileNo >= 0) {
    const i = lines.findIndex((l, k) => k > fileNo + 1 && STATE_OR_ID.test(l));
    end = i < 0 ? undefined : i;
  }
  if (end === undefined) return undefined;
  const above = lines.slice(0, end).filter(Boolean); // blank lines skipped
  const name = above[above.length - 1];
  return nameLike(name) && !nameLike(above[above.length - 2]) ? name : undefined;
}

export function identityOf(pages: readonly string[]): FileIdentity {
  const cover = pages.slice(0, COVER_PAGES);
  if (cover.length === 0) return {};
  const lines = cover.flatMap((p) => p.split("\n")).map((l) => clean(l.replace(/\s*\|\s*/g, " ")));
  const kind = classifyDocument(cover); // decides the form, including a cover that names another form (20-F, 10-KT ...)
  if (kind.confidence === "unknown" || kind.form === "unknown") return {};
  const form: Form = kind.form;
  const id: FileIdentity = { form };
  if (lines.some((l) => AMENDMENT.test(l))) id.amendment = true;
  if (form === "10-K" || form === "10-Q" || form === "8-K") {
    // The period is on the heading block's own line, which ends where the file number or the registrant label begins; later
    // lines hold other dates (the market-value date, a quarter end). No end line, no period.
    const start = lines.findIndex((l) => FORM_HEADING.test(l) || TITLE_PHRASE.test(l));
    const stop = lines.findIndex((l, i) => i > start && (FILE_NUMBER.test(l) || REGISTRANT_LABEL.test(l)));
    if (start >= 0 && stop > start) {
      const block = lines.slice(start, stop).join(" ");
      const head = PERIOD_HEAD[form].exec(block);
      const period = head ? dateOf(block.slice(head.index + head[0].length)) : undefined;
      if (period) id.periodEnd = period;
    }
    const company = companyOf(lines);
    if (company) id.company = company;
  }
  return id;
}

/** One line for the model and the user: "THE BOEING COMPANY · 10-K · FY ended December 31, 2022". Empty when nothing was read. */
export function describeIdentity(id: FileIdentity | undefined): string {
  if (!id?.form) return "";
  const form = id.form === "earnings" ? "earnings release" : `${id.form}${id.amendment ? "/A" : ""}`;
  const period = id.periodEnd ? (id.form === "10-K" ? `FY ended ${id.periodEnd}` : id.form === "10-Q" ? `quarter ended ${id.periodEnd}` : id.form === "8-K" ? `dated ${id.periodEnd}` : "") : "";
  return [id.company, form, period].filter(Boolean).join(" · ");
}

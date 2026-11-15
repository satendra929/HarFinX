// Made-up documents for the document-kind detector: page texts as the PDF reader returns them (rows with `|` between cells).
// Nothing here is a real company or a real filing; the negatives are documents that talk like a filing but are not one.
const filler = (n: number) => Array.from({ length: n }, (_, i) => `The company continues to evaluate conditions in its markets and the risks described elsewhere in this report, item ${i + 1}.`).join("\n");
const table = (title: string, rows: string[][]) => ["ACME Corp", title, "(in millions)", "December 31  |  2022  |  2021", ...rows.map((r) => r.join("  |  "))].join("\n");

export const bsRows = [["Cash and cash equivalents", "1,200", "1,100"], ["Accounts receivable", "800", "750"], ["Inventories", "600", "580"], ["Total current assets", "2,600", "2,430"], ["Property and equipment, net", "3,000", "2,900"], ["Total assets", "5,600", "5,330"], ["Accounts payable", "700", "650"], ["Total current liabilities", "1,500", "1,400"], ["Long-term debt", "1,800", "1,800"], ["Total liabilities", "3,300", "3,200"], ["Total stockholders' equity", "2,300", "2,130"], ["Total liabilities and stockholders' equity", "5,600", "5,330"]];
export const isRows = [["Net sales", "9,000", "8,400"], ["Cost of sales", "5,400", "5,100"], ["Gross profit", "3,600", "3,300"], ["Operating income", "1,100", "950"], ["Interest expense", "100", "110"], ["Income before income taxes", "1,000", "840"], ["Net income", "780", "650"], ["Diluted earnings per share", "3.10", "2.60"]];
export const cfRows = [["Net income", "780", "650"], ["Depreciation and amortization", "300", "290"], ["Net cash provided by operating activities", "1,300", "1,150"], ["Purchases of property and equipment", "(400)", "(380)"], ["Net cash used in investing activities", "(420)", "(390)"], ["Net cash used in financing activities", "(780)", "(700)"], ["Cash and cash equivalents at end of year", "1,200", "1,100"]];
export { table };

const coverOf = (form: string, phrase: string, period: string) =>
  [
    "UNITED STATES",
    "SECURITIES AND EXCHANGE COMMISSION",
    "Washington, D.C. 20549",
    `FORM ${form}`,
    phrase,
    period,
    "Commission File Number 001-12345",
    "ACME Corp",
    "(Exact name of registrant as specified in its charter)",
    "Indicate by check mark whether the registrant is a large accelerated filer, an accelerated filer or a smaller reporting company.",
    "Pursuant to Section 13 or 15(d) of the Securities Exchange Act of 1934",
  ].join("\n");

const itemPages = (items: string[]) => items.map((it) => `${it}\n${filler(8)}`);
const TEN_K_ITEMS = ["PART I\nItem 1. Business", "Item 1A. Risk Factors", "Item 2. Properties", "PART II\nItem 7. Management's Discussion and Analysis", "Item 8. Financial Statements and Supplementary Data"];

export const REAL_10K = [coverOf("10-K", "ANNUAL REPORT PURSUANT TO SECTION 13 OR 15(d) OF THE SECURITIES EXCHANGE ACT OF 1934", "For the fiscal year ended December 31, 2022"), ...itemPages(TEN_K_ITEMS), table("CONSOLIDATED BALANCE SHEETS", bsRows), table("CONSOLIDATED STATEMENTS OF INCOME", isRows), table("CONSOLIDATED STATEMENTS OF CASH FLOWS", cfRows)];
export const REAL_10Q = [coverOf("10-Q", "QUARTERLY REPORT PURSUANT TO SECTION 13 OR 15(d) OF THE SECURITIES EXCHANGE ACT OF 1934", "For the quarterly period ended June 30, 2023"), ...itemPages(["PART I - FINANCIAL INFORMATION\nItem 1. Financial Statements", "Item 2. Management's Discussion and Analysis", "Item 3. Quantitative and Qualitative Disclosures About Market Risk", "Item 4. Controls and Procedures"]), table("CONDENSED CONSOLIDATED BALANCE SHEETS", bsRows), table("CONDENSED CONSOLIDATED STATEMENTS OF INCOME", isRows), table("CONDENSED CONSOLIDATED STATEMENTS OF CASH FLOWS", cfRows)];
export const REAL_8K = [coverOf("8-K", "CURRENT REPORT PURSUANT TO SECTION 13 OR 15(d) OF THE SECURITIES EXCHANGE ACT OF 1934", "Date of Report: May 2, 2023"), "Item 2.02 Results of Operations and Financial Condition.\nItem 9.01 Financial Statements and Exhibits.\nExhibit 99.1 Press release"];
/** A glossy annual report: marketing pages first, the 10-K cover on the fourth page. */
export const WRAPPED_10K = [...Array.from({ length: 3 }, (_, i) => `Letter to shareholders ${i + 1}\nWe had a great year and thank our people. ${filler(6)}`), ...REAL_10K];
export const EARNINGS_RELEASE = [`FOR IMMEDIATE RELEASE\nACME Corp reports second-quarter 2023 results\n${filler(6)}`, table("CONSOLIDATED STATEMENTS OF INCOME (UNAUDITED)", isRows), table("CONSOLIDATED BALANCE SHEETS (UNAUDITED)", bsRows)];

// Negatives: they speak SEC language but are not a report
export const PROXY_STATEMENT = ["UNITED STATES\nSECURITIES AND EXCHANGE COMMISSION\nWashington, D.C. 20549\nSCHEDULE 14A\nProxy Statement Pursuant to Section 14(a) of the Securities Exchange Act of 1934\nFiled by the Registrant", `Notice of Annual Meeting of Stockholders\n${filler(10)}`, ...Array.from({ length: 6 }, (_, i) => `Proposal ${i + 1}\n${filler(10)}`)];
export const PROSPECTUS = ["PROSPECTUS\nACME Corp\nUp to 10,000,000 shares of common stock\nThis prospectus relates to a registration statement filed with the Securities and Exchange Commission.", ...Array.from({ length: 8 }, (_, i) => `Risk factors ${i + 1}\n${filler(10)}`)];
export const INVESTOR_DECK = Array.from({ length: 16 }, (_, i) => `ACME Corp\nInvestor update\nRevenue growth\n${i + 1}`);
export const ANALYST_NOTE = [`Analyst note: ACME Corp\nAs described in the company's Form 10-K, Item 7 Management's Discussion shows margins improving.\n${filler(10)}`, ...Array.from({ length: 5 }, () => filler(12))];
export const ANNUAL_REPORT_ONLY = [`ACME Corp Annual Report\nOur year in review\n${filler(8)}`, table("CONSOLIDATED BALANCE SHEETS", bsRows), table("CONSOLIDATED STATEMENTS OF INCOME", isRows), table("CONSOLIDATED STATEMENTS OF CASH FLOWS", cfRows)];
export const CONFLICTING_COVER = [coverOf("10-K", "QUARTERLY REPORT PURSUANT TO SECTION 13 OR 15(d) OF THE SECURITIES EXCHANGE ACT OF 1934", "For the quarterly period ended June 30, 2023"), ...itemPages(TEN_K_ITEMS)];

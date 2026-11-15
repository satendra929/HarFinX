// Read-only tool: finds the pages of a PDF that best match a few words, so the model can then read one with read_page.
// Results are short (page, title, one matching line). The snippets are a pointer, not a source: they do not feed the
// provenance ledger, so a figure is only "traced" after the model has read its page.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { DocStore } from "../documents/store.ts";
import type { ParsedPdf } from "../documents/pdf.ts";
import { buildIndex, tokenize, type PageIndex } from "../documents/search.ts";
import { cleanQuery } from "../documents/query.ts";
import type { PageVisits } from "../documents/visits.ts";
import { findSection, outlineOf, type Outline } from "../documents/outline.ts";

const TOP = 5;
const MAX_QUERY_CHARS = 200;
// No digits, as with the guard's text: the model may repeat it.
const REPEATED = "[this is the same search as an earlier one in this question, so the pages are the same: read one of them, or search for different words, or call outline]";

export function searchTool(docs: DocStore, visits?: PageVisits, build: (pages: readonly string[]) => Outline = outlineOf): AgentTool<any> {
  const indexes = new WeakMap<ParsedPdf, PageIndex>(); // one index per parsed document, built on first search
  return {
    name: "search",
    label: "Search",
    description:
      "Find the pages of a PDF (such as a 10-K) that best match some words; then read a page with read_page. " +
      "It matches words printed in the file, so search for row labels or statement names (for example " +
      "'total current assets', 'consolidated statements of operations'), not for concepts the filing may not print " +
      "(such as 'net working capital'). Returns up to 5 pages with a title and the best-matching line. Pass `section` to search inside one Item or Note.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "PDF file path relative to the workspace" },
        query: { type: "string", description: "A few words to look for" },
        section: { type: "string", description: "Optional: search only inside one section of the outline, such as Item 7 or Note 6" },
      },
      required: ["path", "query"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params: { path: string; query: string; section?: string }, signal) => {
      if (typeof params.path !== "string" || !/\.pdf$/i.test(params.path)) throw new Error("search works on PDF files");
      const query = typeof params.query === "string" ? params.query.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS) : "";
      if (!query) throw new Error("give a few words to search for");

      const doc = await docs.pdf(params.path, signal);
      let index = indexes.get(doc);
      if (!index) {
        index = buildIndex(doc.pages);
        indexes.set(doc, index);
      }
      // A section limits the search to its pages; a name that is not found (or no outline) searches the whole file and says so.
      // Without `section` the outline is never built.
      const wanted = typeof params.section === "string" ? params.section.replace(/\s+/g, " ").trim().slice(0, 60) : "";
      let range: { from: number; to: number } | undefined;
      let sectionId = "";
      if (wanted) {
        let entry: ReturnType<typeof findSection>;
        try {
          entry = findSection(build(doc.pages), wanted);
        } catch {
          entry = undefined;
        }
        if (entry) {
          range = { from: entry.from, to: entry.to ?? entry.from };
          sectionId = entry.id;
        }
      }
      // Instruction sentences and date markers are removed before searching; the echo keeps what the model asked.
      const cleaned = cleanQuery(query);
      // The same search twice in one question (same words in any order, same section) returns the same pages: the model is told.
      const repeated = visits?.searchedBefore(params.path, `${wanted.toLowerCase()}|${[...new Set(tokenize(cleaned))].sort().join(" ")}`) ?? false;
      const hits = index.search(cleaned, TOP, range);
      const where = !wanted ? "" : range ? `, section ${sectionId} p.${range.from}${range.to > range.from ? "-" + range.to : ""}` : `; section "${wanted.replace(/["\[\]]/g, "")}" not found, whole file searched`;
      const head = `[search "${query}" in ${params.path} (${index.pages} pages)${where}]${repeated ? "\n" + REPEATED : ""}`;
      const base = { path: params.path, query, ...(wanted ? { section: wanted, range: range ?? null, sectionFound: !!range } : {}) };
      if (hits.length === 0) {
        return { content: [{ type: "text", text: `${head}\nNo page matches. Try other words, such as a row label or a statement name.` }], details: { ...base, pages: [] } };
      }
      const mark = (p: number) => {
        const s = visits?.state(params.path, p);
        return s === "opened" ? " (opened)" : s === "passage" ? " (passage read)" : "";
      };
      const lines = hits.map((h) => `page ${h.page}${mark(h.page)}: ${h.title || "(no title)"}\n  ${h.snippet}`);
      const pages = hits.map((h) => h.page);
      const pending = visits?.pending(params.path, pages) ?? [];
      visits?.listed(params.path, pages);
      const earlier = pending.length ? `\n[listed earlier, not opened: ${pending.map((p) => `p.${p}`).join(", ")}]` : "";
      const text = `${head}\n${lines.join("\n")}${earlier}\n[read a page with read_page(path, page)]`;
      return { content: [{ type: "text", text }], details: { ...base, pages, opened: pages.filter((p) => visits?.state(params.path, p)), pending } };
    },
  };
}

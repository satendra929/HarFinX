// Read-only tool: finds the pages of a PDF that best match a few words, so the model can then read one with read_page.
// Results are short (page, title, one matching line). The snippets are a pointer, not a source: they do not feed the
// provenance ledger, so a figure is only "traced" after the model has read its page.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { DocStore } from "../documents/store.ts";
import type { ParsedPdf } from "../documents/pdf.ts";
import { buildIndex, type PageIndex } from "../documents/search.ts";
import { cleanQuery } from "../documents/query.ts";

const TOP = 5;
const MAX_QUERY_CHARS = 200;

export function searchTool(docs: DocStore): AgentTool<any> {
  const indexes = new WeakMap<ParsedPdf, PageIndex>(); // one index per parsed document, built on first search
  return {
    name: "search",
    label: "Search",
    description:
      "Find the pages of a PDF (such as a 10-K) that best match some words; then read a page with read_page. " +
      "It matches words printed in the file, so search for row labels or statement names (for example " +
      "'total current assets', 'consolidated statements of operations'), not for concepts the filing may not print " +
      "(such as 'net working capital'). Returns up to 5 pages with a title and the best-matching line.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "PDF file path relative to the workspace" },
        query: { type: "string", description: "A few words to look for" },
      },
      required: ["path", "query"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params: { path: string; query: string }, signal) => {
      if (typeof params.path !== "string" || !/\.pdf$/i.test(params.path)) throw new Error("search works on PDF files");
      const query = typeof params.query === "string" ? params.query.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS) : "";
      if (!query) throw new Error("give a few words to search for");

      const doc = await docs.pdf(params.path, signal);
      let index = indexes.get(doc);
      if (!index) {
        index = buildIndex(doc.pages);
        indexes.set(doc, index);
      }
      // Instruction sentences and date markers are removed before searching; the echo keeps what the model asked.
      const hits = index.search(cleanQuery(query), TOP);
      const head = `[search "${query}" in ${params.path} (${index.pages} pages)]`;
      if (hits.length === 0) {
        return { content: [{ type: "text", text: `${head}\nNo page matches. Try other words, such as a row label or a statement name.` }], details: { path: params.path, query, pages: [] } };
      }
      const lines = hits.map((h) => `page ${h.page}: ${h.title || "(no title)"}\n  ${h.snippet}`);
      const text = `${head}\n${lines.join("\n")}\n[read a page with read_page(path, page)]`;
      return { content: [{ type: "text", text }], details: { path: params.path, query, pages: hits.map((h) => h.page) } };
    },
  };
}

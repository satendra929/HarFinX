// Read-only tool: returns one page of a PDF in the workspace (a filing, a report). The model finds the right page
// first (the user names it, or later a search tool does) and reads it here. Long pages come in parts that never cut a
// table row, and a later part repeats the page's units and year header so its numbers are read against the right column.
// File access goes through the document store and the workspace; this file never touches node:fs.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { DocStore } from "../documents/store.ts";
import { carriedHeader, pageLines, splitPage } from "../documents/pages.ts";
import { printedLabelOf } from "../documents/printed.ts";
import type { SourceMeta } from "../provenance.ts";

/**
 * `onShown` receives exactly the page text the model has now seen (used to build the figure-provenance ledger), and
 * where it sits: the file, the page, every line of the page and the index of this part's first line in them.
 */
export function readPageTool(docs: DocStore, onShown?: (label: string, text: string, meta: SourceMeta) => void): AgentTool<any> {
  return {
    name: "read_page",
    label: "Read page",
    description:
      "Read one page of a PDF file (such as a 10-K or 10-Q) from the workspace. `page` is the Nth page of the file, counting from 1; " +
      "it can differ from the page number printed on the page. Tables come back as rows with cells separated by |. " +
      "A long page comes in parts: pass `part` (2, 3, ...) to continue.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "PDF file path relative to the workspace, e.g. filings/ACME_2023_10K.pdf" },
        page: { type: "integer", minimum: 1, description: "Page number, counting from 1 (the Nth page of the file)" },
        part: { type: "integer", minimum: 1, description: "Which part of a long page (default 1)" },
      },
      required: ["path", "page"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params: { path: string; page: number; part?: number }, signal) => {
      const part = params.part ?? 1;
      if (!Number.isInteger(params.page) || params.page < 1) throw new Error("page must be a whole number, 1 or more");
      if (!Number.isInteger(part) || part < 1) throw new Error("part must be a whole number, 1 or more");
      if (typeof params.path !== "string" || !/\.pdf$/i.test(params.path)) throw new Error("read_page reads PDF files; use read_file for text files");

      const doc = await docs.pdf(params.path, signal);
      const total = doc.pages.length;
      if (params.page > total) throw new Error(`page ${params.page} is not in this file: it has ${total} pages`);
      const text = doc.pages[params.page - 1];
      const head = `[page ${params.page} of ${total} in ${params.path}]`;

      const parts = splitPage(text);
      if (parts.length === 0) {
        return { content: [{ type: "text", text: `${head}\n[this page has no text: it may be blank or an image]` }], details: { path: params.path, page: params.page, parts: 0, pages: total } };
      }
      if (part > parts.length) throw new Error(`page ${params.page} has ${parts.length} part${parts.length === 1 ? "" : "s"}; there is no part ${part}`);

      const body = parts[part - 1];
      // Telling the ledger what was shown (and where) must never change what the model gets: a failure here only loses the record.
      try {
        const lineOffset = parts.slice(0, part - 1).reduce((n, p) => n + p.split("\n").length, 0);
        onShown?.(`${params.path} p.${params.page}`, body, { file: params.path, page: params.page, pageLines: pageLines(text), lineOffset, printed: printedLabelOf(doc.pages, params.page) });
      } catch {
        /* see above */
      }
      let out = head + "\n";
      if (part > 1) {
        const carried = carriedHeader(text.split("\n"));
        if (carried.length) out += `[repeated from the top of the page]\n${carried.join("\n")}\n`;
      }
      out += body + "\n";
      out += part < parts.length ? `[page ${params.page}, part ${part} of ${parts.length}; call read_page again with part=${part + 1} for the rest]` : `[end of page ${params.page}${parts.length > 1 ? `, part ${part} of ${parts.length}` : ""}]`;
      return { content: [{ type: "text", text: out }], details: { path: params.path, page: params.page, part, parts: parts.length, pages: total } };
    },
  };
}

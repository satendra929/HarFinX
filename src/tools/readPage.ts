// Read-only tool: returns one page of a PDF in the workspace (a filing, a report). The model finds the right page
// first (the user names it, or the search tool finds it) and reads it here. Long pages come in parts that never cut a
// table row, and a later part repeats the page's units and year header so its numbers are read against the right column.
// File access goes through the document store and the workspace; this file never touches node:fs.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { DocStore } from "../documents/store.ts";
import { carriedHeader, findTerms, markUnlabeled, nearestHeader, pageLines, passage, sectionTitle, splitPage } from "../documents/pages.ts";
import type { PageVisits } from "../documents/visits.ts";
import { printedLabelOf } from "../documents/printed.ts";
import type { SourceMeta } from "../provenance.ts";

/**
 * `onShown` receives exactly the page text the model has now seen (used to build the figure-provenance ledger), and
 * where it sits: the file, the page, every line of the page and the index of this part's first line in them.
 */
export function readPageTool(docs: DocStore, onShown?: (label: string, text: string, meta: SourceMeta) => void, visits?: PageVisits): AgentTool<any> {
  return {
    name: "read_page",
    label: "Read page",
    description:
      "Read one page of a PDF file (such as a 10-K or 10-Q) from the workspace. `page` is the Nth page of the file, counting from 1; " +
      "it can differ from the page number printed on the page. Tables come back as rows with cells separated by |. " +
      "A long page comes in parts: pass `part` (2, 3, ...) to continue. To read only the lines around some words, pass `find`.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "PDF file path relative to the workspace, e.g. filings/ACME_2023_10K.pdf" },
        page: { type: "integer", minimum: 1, description: "Page number, counting from 1 (the Nth page of the file)" },
        part: { type: "integer", minimum: 1, description: "Which part of a long page (default 1)" },
        find: { type: "string", description: "Optional: words printed on the page; only the lines around them are returned" },
      },
      required: ["path", "page"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params: { path: string; page: number; part?: number; find?: string }, signal) => {
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
      const find = typeof params.find === "string" ? params.find.replace(/\s+/g, " ").trim() : "";
      if (parts.length > 0 && findTerms(find).length > 0) {
        const lines = pageLines(text);
        const echo = find.replace(/[\[\]]/g, "").slice(0, 200);
        const found = passage(lines, find);
        if (!found) {
          const title = sectionTitle(lines);
          const out = `[page ${params.page} of ${total} in ${params.path}: no line has "${echo}"${title ? `; the page is titled: ${title.replace(/[\[\]]/g, "")}` : ""}]\n[page ${params.page}: call read_page without find to read it, or search for other words]`;
          return { content: [{ type: "text", text: out }], details: { path: params.path, page: params.page, pages: total, find: echo, windows: [], matched: false, moreWindows: false } };
        }
        const { windows, more } = found;
        const shownLines = new Set(windows.flatMap(([a, b]) => lines.slice(a, b + 1)));
        const header = nearestHeader(lines, windows[0][0]);
        const carried = [header.units, header.period, header.columns].filter((l, i, all): l is string => l !== undefined && !shownLines.has(l) && all.indexOf(l) === i);
        try {
          for (const [a, b] of windows) {
            onShown?.(`${params.path} p.${params.page}`, lines.slice(a, b + 1).join("\n"), { file: params.path, page: params.page, pageLines: lines, lineOffset: a, printed: printedLabelOf(doc.pages, params.page) });
          }
        } catch {
          /* a failed record never changes what the model gets */
        }
        visits?.opened(params.path, params.page, "passage");
        let out = `[page ${params.page} of ${total} in ${params.path}: lines around "${echo}"]\n`;
        if (carried.length) out += `[repeated from above on the page]\n${carried.join("\n")}\n`;
        const shown = markUnlabeled(lines);
        out += windows.map(([a, b]) => shown.slice(a, b + 1).join("\n")).join("\n[...]\n") + "\n";
        const whole = windows.length === 1 && windows[0][0] === 0 && windows[0][1] === lines.length - 1;
        out += whole ? `[end of page ${params.page}]` : more ? `[page ${params.page}: more matching lines follow; call read_page without find for the whole page]` : `[page ${params.page}: part of the page is shown; call read_page without find for the whole page]`;
        return { content: [{ type: "text", text: out }], details: { path: params.path, page: params.page, pages: total, find: echo, windows, matched: true, moreWindows: more } };
      }
      if (parts.length === 0) {
        return { content: [{ type: "text", text: `${head}\n[this page has no text: it may be blank or an image]` }], details: { path: params.path, page: params.page, parts: 0, pages: total } };
      }
      if (part > parts.length) throw new Error(`page ${params.page} has ${parts.length} part${parts.length === 1 ? "" : "s"}; there is no part ${part}`);

      const body = parts[part - 1];
      visits?.opened(params.path, params.page);
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
      out += markUnlabeled(body.split("\n")).join("\n") + "\n";
      // Pages a search listed in this question that are still unopened: said where the model decides what to read next.
      const waiting = visits?.pending(params.path, [params.page]) ?? [];
      if (waiting.length) out += `[listed by search, not opened: ${waiting.map((p) => `p.${p}`).join(", ")}]\n`;
      out += part < parts.length ? `[page ${params.page}, part ${part} of ${parts.length}; call read_page again with part=${part + 1} for the rest]` : `[end of page ${params.page}${parts.length > 1 ? `, part ${part} of ${parts.length}` : ""}]`;
      return { content: [{ type: "text", text: out }], details: { path: params.path, page: params.page, part, parts: parts.length, pages: total } };
    },
  };
}

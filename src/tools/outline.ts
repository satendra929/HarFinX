// Read-only tool: a map of one PDF filing (Items, main statements, Notes, with pages), built from the pages already
// parsed. It is a map, not a source: it never feeds the provenance ledger, so a figure is traced only after its page is read.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { DocStore } from "../documents/store.ts";
import { formatOutline, outlineOf, type Outline } from "../documents/outline.ts";

export function outlineTool(docs: DocStore, build: (pages: readonly string[]) => Outline = outlineOf): AgentTool<any> {
  return {
    name: "outline",
    label: "Outline",
    description:
      "List the sections of a PDF filing with their pages: Items, the main financial statements and the Notes. " +
      "Use it to find where a topic is (risk factors, MD&A, legal proceedings, a Note) before you search or read. It is a map, not a source.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "PDF file path relative to the workspace" } },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params: { path: string }, signal) => {
      if (typeof params.path !== "string" || !/\.pdf$/i.test(params.path)) throw new Error("outline works on PDF files");
      const doc = await docs.pdf(params.path, signal);
      let o: Outline = { entries: [], contentsPages: [] };
      try {
        o = build(doc.pages);
      } catch {
        /* no outline found */
      }
      const count = (k: string) => o.entries.filter((e) => e.kind === k).length;
      const details = { path: params.path, pages: doc.pages.length, items: count("item"), statements: count("statement"), notes: count("note"), contentsPages: o.contentsPages, found: o.entries.length > 0 };
      return { content: [{ type: "text", text: formatOutline(o, params.path, doc.pages.length) }], details };
    },
  };
}

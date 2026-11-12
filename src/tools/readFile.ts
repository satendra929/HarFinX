// Read-only tool: returns a chunk of a UTF-8 text file from the workspace.
// All path checks live in Workspace.readText; this file never touches node:fs or builds paths.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Workspace } from "../workspace.ts";

// Must stay below the guard's per-result cap (maxOutputChars) so the "more available" note is not cut off.
export const CHUNK_CHARS = 4000;

/**
 * The text of a chunk that is safe to treat as "shown to the model" for provenance: a number cut by a chunk edge
 * is excluded at the end and included whole at the start of the chunk that continues it.
 */
export function shownSlice(text: string, offset: number, end: number): string {
  let from = offset;
  while (from > 0 && !/\s/.test(text[from - 1])) from--; // head of a token split by the previous chunk
  let to = end;
  if (end < text.length && !/\s/.test(text[end - 1]) && !/\s/.test(text[end])) {
    const cut = text.slice(offset, end).search(/\S+$/); // start of the trailing partial token
    if (cut > 0) to = offset + cut;
  }
  return text.slice(from, to);
}

/** `onShown` receives the file text the model has now seen (used to build the figure-provenance ledger). */
export function readFileTool(workspace: Workspace, onShown?: (path: string, text: string) => void): AgentTool<any> {
  return {
    name: "read_file",
    label: "Read file",
    description:
      "Read a UTF-8 text file (csv, txt, md, json) from the workspace folder. " +
      "`path` is relative to the workspace. Long files come back in chunks; " +
      "pass `offset` (a character position) to continue where the previous chunk ended.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace, e.g. income-statement.csv" },
        offset: { type: "integer", minimum: 0, description: "Character position to start from (default 0)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params: { path: string; offset?: number }, signal) => {
      const offset = params.offset ?? 0;
      if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");

      const text = await workspace.readText(params.path, { signal });
      if (offset >= text.length && text.length > 0) {
        return { content: [{ type: "text", text: `[offset ${offset} is past the end of the file (${text.length} characters)]` }], details: {} };
      }
      const end = Math.min(offset + CHUNK_CHARS, text.length);
      onShown?.(params.path, shownSlice(text, offset, end));
      let out = text.slice(offset, end);
      out +=
        end < text.length
          ? `\n[characters ${offset}-${end} of ${text.length}; call read_file again with offset=${end} for more]`
          : `\n[end of file: characters ${offset}-${end} of ${text.length}]`;
      return { content: [{ type: "text", text: out }], details: { path: params.path, offset, end, total: text.length } };
    },
  };
}

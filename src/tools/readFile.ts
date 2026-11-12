// Read-only tool: returns a chunk of a UTF-8 text file from the workspace.
// All path checks live in Workspace.readText; this file never touches node:fs or builds paths.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Workspace } from "../workspace.ts";

// Must stay below the guard's per-result cap (maxOutputChars) so the "more available" note is not cut off.
export const CHUNK_CHARS = 4000;

export function readFileTool(workspace: Workspace): AgentTool<any> {
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
      let out = text.slice(offset, end);
      out +=
        end < text.length
          ? `\n[characters ${offset}-${end} of ${text.length}; call read_file again with offset=${end} for more]`
          : `\n[end of file: characters ${offset}-${end} of ${text.length}]`;
      return { content: [{ type: "text", text: out }], details: { path: params.path, offset, end, total: text.length } };
    },
  };
}

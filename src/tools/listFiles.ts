// Read-only tool: lists the files in the workspace (names and sizes only; nothing is opened or parsed), so the model
// can find the filing a user means ("the Boeing 10-K") instead of guessing a file name.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Workspace } from "../workspace.ts";

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The listing text the tool returns: a count line, then "path  (size)" per file. The engine uses it too, so both read the same. */
export function formatListing(files: readonly { path: string; size: number }[], truncated: boolean): string {
  if (files.length === 0) return "[the workspace folder has no files]";
  const lines = files.map((f) => `${f.path.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")}  (${humanSize(f.size)})`);
  const head = `[${files.length} file${files.length === 1 ? "" : "s"} in the workspace${truncated ? "; more exist, only the first ones are shown" : ""}]`;
  return `${head}\n${lines.join("\n")}`;
}

export function listFilesTool(workspace: Workspace): AgentTool<any> {
  return {
    name: "list_files",
    label: "List files",
    description: "List the files in the workspace folder (path and size). Use it to find the file a question is about before reading or searching it.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      const { files, truncated } = workspace.list();
      return { content: [{ type: "text", text: formatListing(files, truncated) }], details: { count: files.length, truncated } };
    },
  };
}

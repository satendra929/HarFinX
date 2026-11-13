// Read-only tool: lists the files in the workspace (names and sizes only; nothing is opened or parsed), so the model
// can find the filing a user means ("the Boeing 10-K") instead of guessing a file name.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Workspace } from "../workspace.ts";

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function listFilesTool(workspace: Workspace): AgentTool<any> {
  return {
    name: "list_files",
    label: "List files",
    description: "List the files in the workspace folder (path and size). Use it to find the file a question is about before reading or searching it.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      const { files, truncated } = workspace.list();
      if (files.length === 0) return { content: [{ type: "text", text: "[the workspace folder has no files]" }], details: { count: 0 } };
      const lines = files.map((f) => `${f.path}  (${humanSize(f.size)})`);
      const head = `[${files.length} file${files.length === 1 ? "" : "s"} in the workspace${truncated ? "; more exist, only the first ones are shown" : ""}]`;
      return { content: [{ type: "text", text: `${head}\n${lines.join("\n")}` }], details: { count: files.length, truncated } };
    },
  };
}

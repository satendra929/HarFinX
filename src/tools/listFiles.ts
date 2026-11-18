// Read-only tool: lists the files in the workspace (path, size and, for PDFs, which filing each is) so the model can find
// the filing a user means ("the Boeing 10-K") instead of guessing a file name. Which filing a PDF is comes from a cheap look
// at its first pages (src/documents/identity.ts), for the first IDENTITY_MAX files, one at a time and within a time budget;
// a file that cannot be read or has no clear cover is listed as before. Nothing is kept on disk.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Workspace } from "../workspace.ts";
import type { DocStore } from "../documents/store.ts";
import { describeIdentity } from "../documents/identity.ts";

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Files whose cover is looked at (the first ones of the listing), and the time all the looks together may take. */
export const IDENTITY_MAX = 20;
export const IDENTITY_BUDGET_MS = 4_000;

const NOTE = "[company, form and period end are read from each PDF's cover; a part that is missing could not be read]";
const tidy = (s: string) => s.replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");

/** The listing text the tool returns: a count line, then "path  (size)  —  identity" per file. The engine uses it too, so both read the same. */
export function formatListing(files: readonly { path: string; size: number }[], truncated: boolean, identities?: ReadonlyMap<string, string>): string {
  if (files.length === 0) return "[the workspace folder has no files]";
  const lines = files.map((f) => {
    const id = identities?.get(f.path);
    return `${tidy(f.path)}  (${humanSize(f.size)})${id ? `  —  ${tidy(id)}` : ""}`;
  });
  const head = `[${files.length} file${files.length === 1 ? "" : "s"} in the workspace${truncated ? "; more exist, only the first ones are shown" : ""}]`;
  return `${head}\n${lines.join("\n")}${identities?.size ? `\n${NOTE}` : ""}`;
}

/**
 * Which filing each of the first IDENTITY_MAX PDFs is: path to "company · form · period". One file at a time; when the time
 * budget is spent the rest are left out, and so is any file whose look fails (never an error). `store` undefined: none.
 */
export async function identify(
  files: readonly { path: string }[],
  store: DocStore | undefined,
  signal?: AbortSignal,
  budgetMs: number = IDENTITY_BUDGET_MS,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (!store) return found;
  // The budget is a signal too, so a look that is still running when the time is up is cut, not waited for.
  const limit = AbortSignal.any([AbortSignal.timeout(Math.max(1, budgetMs)), ...(signal ? [signal] : [])]);
  for (const f of files.slice(0, IDENTITY_MAX)) {
    if (!/\.pdf$/i.test(f.path)) continue;
    if (limit.aborted) break;
    try {
      const text = describeIdentity(await store.cover(f.path, limit));
      if (text) found.set(f.path, text);
    } catch {
      // unreadable, too large, gone: the file is listed without identity
    }
  }
  return found;
}

export function listFilesTool(workspace: Workspace, store?: DocStore): AgentTool<any> {
  return {
    name: "list_files",
    label: "List files",
    description:
      "List the files in the workspace folder (path, size and, for PDF filings, the company, form and period end read from the cover). Use it to find the file a question is about before reading or searching it.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async (_id, _params, signal) => {
      const { files, truncated } = workspace.list();
      const identities = await identify(files, store, signal);
      return { content: [{ type: "text", text: formatListing(files, truncated, identities) }], details: { count: files.length, truncated, identified: identities.size } };
    },
  };
}

// In-memory cache of parsed documents for one session: a filing is parsed once, however many pages are read.
// Keyed by the file's content hash, so a changed file is parsed again and the same file under two names once.
// Nothing is written to disk. A failed parse is not cached (the next call tries again).
import { createHash } from "node:crypto";
import type { Workspace } from "../workspace.ts";
import { parsePdf, type ParsedPdf } from "./pdf.ts";

export interface DocStore {
  /** The parsed pages of a PDF in the workspace. Path checks happen in the workspace; errors are PdfError or the workspace's. */
  pdf(rel: string, signal?: AbortSignal): Promise<ParsedPdf>;
}

export function createDocStore(workspace: Workspace, parse: (bytes: Uint8Array, signal?: AbortSignal) => Promise<ParsedPdf> = (b, signal) => parsePdf(b, { signal })): DocStore {
  const cache = new Map<string, Promise<ParsedPdf>>();
  return {
    async pdf(rel, signal) {
      const bytes = await workspace.readBytes(rel, { signal });
      const key = createHash("sha256").update(bytes).digest("hex");
      let parsed = cache.get(key);
      if (!parsed) {
        parsed = parse(bytes, signal);
        cache.set(key, parsed);
        parsed.catch(() => cache.delete(key));
      }
      return parsed;
    },
  };
}

// In-memory cache of parsed documents for one session: a filing is parsed once, however many pages are read.
// Keyed by the file's content hash, so a changed file is parsed again and the same file under two names once.
// Nothing is written to disk. A failed parse is not cached (the next call tries again).
// `cover` is the cheap look at a file's first pages that says which filing it is (src/documents/identity.ts); its result,
// including "could not be read", is kept by content hash too, so a file that fails is not tried again.
import { createHash } from "node:crypto";
import type { Workspace } from "../workspace.ts";
import { parsePdf, type ParsedPdf } from "./pdf.ts";
import { COVER_PAGES, identityOf, type FileIdentity } from "./identity.ts";

export interface DocStore {
  /** The parsed pages of a PDF in the workspace. Path checks happen in the workspace; errors are PdfError or the workspace's. */
  pdf(rel: string, signal?: AbortSignal): Promise<ParsedPdf>;
  /** Which filing a PDF is, read from its first pages; undefined when the file cannot be read or its cover is not clear. Path errors are thrown. */
  cover(rel: string, signal?: AbortSignal): Promise<FileIdentity | undefined>;
}

/** A cover look has little to read: a short time limit and a small heap, so a bad file costs seconds, not minutes. */
export const COVER_LIMITS = { timeoutMs: 3_000, memoryMb: 256 };

type Parser = (bytes: Uint8Array, signal?: AbortSignal) => Promise<ParsedPdf>;

export function createDocStore(
  workspace: Workspace,
  parseGiven?: Parser,
  /** Reads the first pages only. When omitted: the parser given (tests pass a fake one for both), else the worker with cover limits. */
  parseCoverGiven?: Parser,
): DocStore {
  const parse: Parser = parseGiven ?? ((b, signal) => parsePdf(b, { signal }));
  const parseCover: Parser = parseCoverGiven ?? parseGiven ?? parseCoverPdf;
  const cache = new Map<string, Promise<ParsedPdf>>();
  const covers = new Map<string, Promise<FileIdentity | undefined>>();
  const hashOf = async (rel: string, signal?: AbortSignal) => {
    const bytes = await workspace.readBytes(rel, { signal });
    return { bytes, key: createHash("sha256").update(bytes).digest("hex") };
  };
  return {
    async pdf(rel, signal) {
      const { bytes, key } = await hashOf(rel, signal);
      let parsed = cache.get(key);
      if (!parsed) {
        parsed = parse(bytes, signal);
        cache.set(key, parsed);
        parsed.catch(() => cache.delete(key));
      }
      return parsed;
    },
    async cover(rel, signal) {
      const { bytes, key } = await hashOf(rel, signal);
      let found = covers.get(key);
      if (!found) {
        // Always its own short look: a full parse that is still running or has failed (aborted, too slow) must not decide what a cover says.
        found = parseCover(bytes, signal).then(
          (p) => identityOf(p.pages.slice(0, COVER_PAGES)),
          () => undefined,
        );
        covers.set(key, found);
        found.then(() => signal?.aborted && covers.delete(key)); // a look cut short (by the user or the time budget) says nothing about the file
      }
      return found;
    },
  };
}

/** The cover parser used outside tests. */
export const parseCoverPdf = (bytes: Uint8Array, signal?: AbortSignal): Promise<ParsedPdf> => parsePdf(bytes, { signal, firstPages: COVER_PAGES, ...COVER_LIMITS });

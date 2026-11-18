// Reads a PDF into page texts. The PDF is untrusted input, so it is parsed in a worker thread with a memory limit and
// a time limit: a hostile or broken file can fail its question, never the session. Errors have fixed, friendly texts
// (nothing from inside the file is echoed back). All file access happens elsewhere (workspace.ts hands over bytes).
import { Worker } from "node:worker_threads";

export interface ParsedPdf {
  /** Text of each page, in order; page n of the file is pages[n - 1]. */
  pages: string[];
}

export type PdfErrorCode = "invalid" | "password" | "too_many_pages" | "too_much_text" | "no_text" | "timeout" | "memory" | "aborted" | "failed";

export class PdfError extends Error {
  constructor(
    readonly code: PdfErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ParseOptions {
  timeoutMs?: number;
  maxPages?: number;
  maxPageChars?: number;
  maxTotalChars?: number;
  /** Heap limit of the worker, in MB. */
  memoryMb?: number;
  /** Read only the first n pages (a cover look: the result has up to n pages, and the scanned-document check is skipped). */
  firstPages?: number;
  /** Test hook: another worker script. */
  workerUrl?: URL;
  signal?: AbortSignal;
}

export const PDF_LIMITS = { timeoutMs: 30_000, maxPages: 1_000, maxPageChars: 50_000, maxTotalChars: 3_000_000, memoryMb: 1_024 };

function message(code: PdfErrorCode, o: Required<Pick<ParseOptions, "timeoutMs" | "maxPages">>, pages?: number): string {
  switch (code) {
    case "invalid":
      return "This file is not a readable PDF (it may be corrupted).";
    case "password":
      return "This PDF is password-protected, so it cannot be read.";
    case "too_many_pages":
      return `This PDF has ${pages ?? "too many"} pages; the limit is ${o.maxPages}.`;
    case "too_much_text":
      return "This PDF holds more text than the reader accepts.";
    case "no_text":
      return "This PDF has no text layer (it looks scanned). Scanned PDFs are not supported yet.";
    case "timeout":
      return `Reading this PDF took longer than ${Math.round(o.timeoutMs / 1000)} seconds, so it was stopped.`;
    case "memory":
      return "This PDF needs too much memory to read.";
    case "aborted":
      return "Reading the PDF was cancelled.";
    default:
      return "This PDF could not be read.";
  }
}

export function parsePdf(bytes: Uint8Array, opts: ParseOptions = {}): Promise<ParsedPdf> {
  const o = {
    timeoutMs: opts.timeoutMs ?? PDF_LIMITS.timeoutMs,
    maxPages: opts.maxPages ?? PDF_LIMITS.maxPages,
    maxPageChars: opts.maxPageChars ?? PDF_LIMITS.maxPageChars,
    maxTotalChars: opts.maxTotalChars ?? PDF_LIMITS.maxTotalChars,
    memoryMb: opts.memoryMb ?? PDF_LIMITS.memoryMb,
  };
  const copy = new Uint8Array(bytes); // transferred to the worker; the caller's buffer stays usable
  const url = opts.workerUrl ?? new URL("./pdfWorker.ts", import.meta.url);

  return new Promise<ParsedPdf>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new PdfError("aborted", message("aborted", o)));
    const worker = new Worker(url, {
      workerData: { bytes: copy, maxPages: o.maxPages, maxPageChars: o.maxPageChars, maxTotalChars: o.maxTotalChars, firstPages: opts.firstPages },
      transferList: [copy.buffer],
      resourceLimits: { maxOldGenerationSizeMb: o.memoryMb, maxYoungGenerationSizeMb: 64 },
    });
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      fn();
    };
    const fail = (code: PdfErrorCode, pages?: number) => finish(() => reject(new PdfError(code, message(code, o, pages))));
    const timer = setTimeout(() => fail("timeout"), o.timeoutMs);
    const onAbort = () => fail("aborted");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    worker.on("message", (m: { ok: boolean; pages?: string[]; code?: PdfErrorCode; detail?: number }) => {
      if (m && m.ok && Array.isArray(m.pages)) finish(() => resolve({ pages: m.pages as string[] }));
      else fail(m?.code ?? "failed", m?.detail);
    });
    worker.on("error", (err: Error & { code?: string }) => fail(err.code === "ERR_WORKER_OUT_OF_MEMORY" ? "memory" : "failed"));
    worker.on("exit", () => fail("failed")); // exit without a result
  });
}

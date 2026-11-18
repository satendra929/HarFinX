// Runs inside a worker thread (see pdf.ts): parses one PDF and reports its pages as text. It exists so that a hostile
// or broken PDF can be stopped by the parent (timeout, memory limit) without taking the session down.
// No file access and no network here: the bytes arrive in workerData and only text goes back.
import { parentPort, workerData } from "node:worker_threads";
import { getDocumentProxy } from "unpdf";
import { itemsToText, type TextItem } from "./rows.ts";

interface Input {
  bytes: Uint8Array;
  maxPages: number;
  maxPageChars: number;
  maxTotalChars: number;
  /** Only the first n pages are read (a cover look). */
  firstPages?: number;
}
type Failure = "invalid" | "password" | "too_many_pages" | "too_much_text" | "no_text" | "failed";
const reply = (m: { ok: true; pages: string[] } | { ok: false; code: Failure; detail?: number }) => parentPort!.postMessage(m);

async function main(): Promise<void> {
  const { bytes, maxPages, maxPageChars, maxTotalChars, firstPages } = workerData as Input;
  let pdf;
  try {
    // Text only: no system fonts, no font loading, no logging. (This pdf.js build has no script-evaluation option.)
    pdf = await getDocumentProxy(bytes, { useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  } catch (err) {
    const name = (err as { name?: string })?.name ?? "";
    return reply({ ok: false, code: name === "PasswordException" ? "password" : name === "InvalidPDFException" ? "invalid" : "failed" });
  }
  if (pdf.numPages > maxPages) return reply({ ok: false, code: "too_many_pages", detail: pdf.numPages });

  const pages: string[] = [];
  let total = 0;
  const last = firstPages ? Math.min(pdf.numPages, firstPages) : pdf.numPages;
  for (let n = 1; n <= last; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const items: TextItem[] = [];
    for (const raw of content.items) {
      const t = raw as { str?: string; transform?: number[]; width?: number; height?: number };
      if (typeof t.str !== "string" || !t.transform) continue; // marked-content entries carry no text
      items.push({ str: t.str, x: t.transform[4], y: t.transform[5], width: t.width ?? 0, height: t.height ?? 0 });
    }
    let text = itemsToText(items).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ");
    if (text.length > maxPageChars) text = text.slice(0, maxPageChars) + `\n[page text cut at ${maxPageChars} characters]`;
    total += text.length;
    if (total > maxTotalChars) return reply({ ok: false, code: "too_much_text" });
    pages.push(text);
    page.cleanup();
  }
  // Scanned documents have images but almost no text: say so instead of returning empty pages.
  const withText = pages.filter((p) => p.trim().length >= 20).length;
  if (!firstPages && pages.length > 0 && withText / pages.length < 0.2) return reply({ ok: false, code: "no_text" });
  reply({ ok: true, pages });
}

main().catch(() => reply({ ok: false, code: "failed" }));

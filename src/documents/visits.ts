// What the model has opened during the current question: whole pages (or a part of one), passages, and the pages that
// searches listed. Used to mark search hits "(opened)" / "(passage read)" and to name listed pages never opened.
// Scope is one question: an earlier question's pages may no longer be in what the model sees. Pure: no I/O.
import { fileKey } from "../sources.ts";

export type PageState = "opened" | "passage";

export class PageVisits {
  private seen = new Map<string, Map<number, PageState>>();
  private offered = new Map<string, number[]>();
  private searches = new Set<string>();
  private names = new Map<string, string>(); // file key -> the path as the model wrote it (for messages)

  reset(): void {
    this.seen.clear();
    this.offered.clear();
    this.searches.clear();
    this.names.clear();
  }

  /** Notes a search (file plus a normalized form of the query and section); true when this question already ran the same one. */
  searchedBefore(file: string, normalizedQuery: string): boolean {
    const key = fileKey(file) + "|" + normalizedQuery;
    const again = this.searches.has(key);
    this.searches.add(key);
    return again;
  }

  /** A page (or a part of it) was shown. A passage never downgrades a page already opened. */
  opened(file: string, page: number, state: PageState = "opened"): void {
    const k = fileKey(file);
    const m = this.seen.get(k) ?? new Map<number, PageState>();
    if (state === "passage" && m.get(page) === "opened") return;
    m.set(page, state);
    this.seen.set(k, m);
  }

  /** A search listed these pages (in rank order). */
  listed(file: string, pages: readonly number[]): void {
    const k = fileKey(file);
    const l = this.offered.get(k) ?? [];
    for (const p of pages) if (!l.includes(p)) l.push(p);
    this.offered.set(k, l);
    if (!this.names.has(k)) this.names.set(k, file);
  }

  /** True when a search ran in this question (even one that listed nothing). */
  searched(): boolean {
    return this.searches.size > 0;
  }

  /** How many distinct pages of the file were looked at in this question (opened, a part of one, or a passage: each page once). */
  looked(file: string): number {
    return this.seen.get(fileKey(file))?.size ?? 0;
  }

  /**
   * Whether the question has looked at fewer than `min` distinct pages (an opened page, a part of one or a passage each count
   * once) of the file that searches listed the most pages of, and which listed pages to open next, in rank order, to reach
   * `min` (at most `max`). Undefined: no search listed anything, `min` is 0, or enough pages were looked at.
   */
  thin(min: number, max = min): { file: string; looked: number; missing: number[] } | undefined {
    if (!(min > 0)) return undefined;
    let best: string | undefined;
    for (const [k, l] of this.offered) if (l.length && (best === undefined || l.length > (this.offered.get(best)?.length ?? 0))) best = k;
    if (best === undefined) return undefined;
    const file = this.names.get(best) ?? best;
    const looked = this.looked(file);
    if (looked >= min) return undefined;
    const missing = this.pending(file, [], Math.min(min - looked, max));
    return missing.length ? { file, looked, missing } : undefined;
  }

  state(file: string, page: number): PageState | undefined {
    return this.seen.get(fileKey(file))?.get(page);
  }

  /** Pages listed earlier in this question and not opened at all, at most `max`, not among `exclude`. A passage counts as a look. */
  pending(file: string, exclude: readonly number[] = [], max = 5): number[] {
    const k = fileKey(file);
    return (this.offered.get(k) ?? []).filter((p) => this.state(file, p) === undefined && !exclude.includes(p)).slice(0, max);
  }
}

// A map of one filing: its Items, primary statements and Notes with page ranges, found from the page texts alone.
// Pure: no I/O. General rules about how filings are laid out (numbered headings in order, statement titles at the top of
// a table page, contents pages that list headings with page numbers); no company wording. When the detector is not
// sure it shows less, never a guess: every rule below drops output, none invents it.

export interface OutlineEntry {
  kind: "item" | "statement" | "note";
  id: string; // "Item 1A", "Part II Item 1A", "Note 7", "Balance sheet"
  title: string; // full title, may be empty
  from: number; // page, counting from 1
  to?: number;
  brief?: boolean; // few lines under the heading: the content is probably elsewhere (an index entry)
}
export interface Outline {
  entries: OutlineEntry[];
  contentsPages: number[];
}

export const OUTLINE_CHARS = 2200;
const MAX_CANDIDATES = 2000;
const MAX_LINE = 200;

interface Cand {
  kind: "item" | "note" | "numbered";
  page: number;
  line: number;
  part: number; // 0 when unknown
  num: number;
  letter: string;
  title: string;
  endsNum: boolean; // the line ends with a page number (a contents line)
}

const ITEM = /^\s*(?:(?:Part|PART)\s+(IV|I{1,3})\b[\s.,:;|\-–—]*)?(?:Item|ITEM)\s*(\d{1,2}(?:\.\d{2})?)([A-Za-z])?(?![A-Za-z0-9])\s*[.:\-–—|]*\s*(.*)$/;
const PART = /(?:^|\|)\s*(?:Part|PART)\s+(IV|I{1,3})\b([^|]*)/;
const NOTE = /^\s*(?:Note|NOTE)\s+(\d{1,2})(?![A-Za-z0-9])\s*[.:\-–—|]*\s*(.*)$/;
const NUMBERED = /^\s*(\d{1,2})\.\s+([A-Z][^|]{2,108})$/;
const ENDS_NUM = /(?:\s|\||\.)\d{1,3}\s*$/;
const CUE = /(?:,|\b(?:see|in|under|to|and|of|with|the|our))\s*$/i;
const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4 };

const clean = (s: string) =>
  (s.split("|").map((c) => c.trim()).find((c) => c) ?? "").replace(/\s*\.{2,}.*$/, "").replace(/\s+\d{1,3}$/, "").replace(/^[\s.:\-–—]+/, "").trim();
const headingLike = (l: string) => l.length > 0 && l.length <= 100 && /^[A-Z]/.test(l) && !l.includes("|") && !/,$/.test(l) && !ITEM.test(l) && !NOTE.test(l) && !PART.test(l);

function collect(pages: readonly string[], skip: ReadonlySet<number>, wantNumbered: boolean): { cands: Cand[]; parts: { page: number; line: number; part: number }[] } {
  const cands: Cand[] = [];
  const parts: { page: number; line: number; part: number }[] = [];
  let part = 0;
  pages.forEach((text, pi) => {
    const page = pi + 1;
    if (skip.has(page)) return;
    const lines = text.split("\n").map((l) => l.slice(0, MAX_LINE));
    let prev = "";
    lines.forEach((raw, li) => {
      const line = raw.trim();
      if (!line) return;
      const before = prev;
      prev = line;
      const pm = PART.exec(line);
      if (pm && line.length <= 100 && !/[a-z]{4,}\s+[a-z]{4,}\s+[a-z]{4,}/.test(pm[2])) {
        part = Math.max(part, ROMAN[pm[1]]);
        parts.push({ page, line: li, part });
      }
      const tail = (m: string, id?: string) => {
        let title = clean(m);
        if (!title && id !== undefined) {
          const next = (lines[li + 1] ?? "").trim();
          if (headingLike(next)) title = clean(next);
        }
        return title;
      };
      const im = ITEM.exec(line);
      if (im && !CUE.test(before) && !/^[a-z]/.test(im[4])) {
        if (im[1]) part = Math.max(part, ROMAN[im[1]]);
        cands.push({ kind: "item", page, line: li, part: im[1] ? ROMAN[im[1]] : part, num: parseFloat(im[2]), letter: (im[3] ?? "").toUpperCase(), title: tail(im[4], "x"), endsNum: ENDS_NUM.test(line) });
        return;
      }
      const nm = NOTE.exec(line);
      if (nm && !CUE.test(before) && !/^[a-z]/.test(nm[2])) {
        cands.push({ kind: "note", page, line: li, part: 0, num: parseInt(nm[1], 10), letter: "", title: tail(nm[2], "x"), endsNum: ENDS_NUM.test(line) });
        return;
      }
      const nu = wantNumbered ? NUMBERED.exec(line) : null;
      if (nu && !/[.?!;:,]$/.test(nu[2]) && !/\d$/.test(nu[2])) cands.push({ kind: "numbered", page, line: li, part: 0, num: parseInt(nu[1], 10), letter: "", title: clean(nu[2]), endsNum: false });
    });
  });
  return { cands, parts };
}

/** Pages that list headings with page numbers (a table of contents or a notes index). */
function contentsPagesOf(pages: readonly string[]): Set<number> {
  const out = new Set<number>();
  pages.forEach((text, pi) => {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    let items = 0;
    let itemsNum = 0;
    let notes = 0;
    let notesNum = 0;
    for (const l of lines) {
      const line = l.slice(0, MAX_LINE);
      if (ITEM.test(line)) {
        items++;
        if (ENDS_NUM.test(line)) itemsNum++;
      } else if (NOTE.test(line)) {
        notes++;
        if (ENDS_NUM.test(line)) notesNum++;
      }
    }
    if ((items >= 5 && itemsNum / items >= 0.6) || (items >= 8 && items / Math.max(1, lines.length) >= 0.4)) out.add(pi + 1);
    if (notes >= 5 && notesNum / notes >= 0.6) out.add(pi + 1);
  });
  return out;
}

const keyOf = (c: Cand) => [c.part, c.num, c.letter.charCodeAt(0) || 0];
function less(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** The longest chain whose keys strictly increase, in document order (earliest on ties). Returns indexes into `c`. */
function chain(c: readonly Cand[]): number[] {
  const keys = c.map(keyOf);
  const len = new Array<number>(c.length).fill(1);
  const prev = new Array<number>(c.length).fill(-1);
  let best = -1;
  for (let i = 0; i < c.length; i++) {
    for (let j = 0; j < i; j++) if (less(keys[j], keys[i]) && len[j] + 1 > len[i]) (len[i] = len[j] + 1), (prev[i] = j);
    if (best < 0 || len[i] > len[best]) best = i;
  }
  const out: number[] = [];
  for (let i = best; i >= 0; i = prev[i]) out.unshift(i);
  return out;
}

const STATEMENTS: { id: string; re: RegExp }[] = [
  { id: "Income statement", re: /^(?:statements? of (?:operations|income|earnings)|income statements?)\b/ },
  { id: "Balance sheet", re: /^(?:balance sheets?|statements? of financial (?:position|condition))\b/ },
  { id: "Cash flow statement", re: /^statements? of cash flows?\b/ },
  { id: "Equity statement", re: /^statements? of (?:changes in )?(?:stockholders|shareholders|owners|members|partners)['’]?s?['’]?\s*(?:equity|deficit|capital)\b/ },
];
const LEAD = /^\W*(?:(?:consolidated|condensed|combined|unaudited|the)\s+)*/i;
const NOT_PRIMARY = /\b(?:analysis|parenthetical|supplemental|summar(?:y|ized)|information|data|schedule|obligor|guarantor)\b/i;

/** The statement a heading line starts with, or undefined. */
function statementOf(line: string): string | undefined {
  const l = line.toLowerCase().replace(LEAD, "");
  const hit = STATEMENTS.find((s) => s.re.test(l));
  if (!hit || /\bcontinued\b/.test(l) || NOT_PRIMARY.test(l.slice(0, 90))) return undefined;
  return hit.id;
}

function statementPages(pages: readonly string[], skip: ReadonlySet<number>): Map<string, number[]> {
  const out = new Map<string, number[]>();
  pages.forEach((text, pi) => {
    if (skip.has(pi + 1)) return;
    const lines = text.split("\n");
    const firstRow = lines.findIndex((l) => l.includes("|"));
    if (firstRow < 0) return;
    const rows = lines.filter((l) => l.includes("|") && /\d/.test(l)).length;
    if (rows < 8) return;
    const kinds = new Set(lines.slice(0, Math.min(firstRow, 8)).map((l) => l.trim()).filter((l) => l.length <= 120).flatMap((l) => statementOf(l) ?? []));
    if (kinds.size !== 1) return; // none, or an index page naming several
    const k = [...kinds][0];
    out.set(k, [...(out.get(k) ?? []), pi + 1]);
  });
  return out;
}

const countLines = (pages: readonly string[], from: number, fromLine: number, to: number, toLine: number): number => {
  let n = 0;
  for (let p = from; p <= to && p <= pages.length; p++) {
    const ls = pages[p - 1].split("\n");
    const a = p === from ? fromLine + 1 : 0;
    const b = p === to ? Math.min(toLine, ls.length) : ls.length;
    for (let i = a; i < b; i++) if (ls[i].trim()) n++;
  }
  return n;
};

export function buildOutline(pages: readonly string[]): Outline {
  const empty: Outline = { entries: [], contentsPages: [] };
  try {
    if (pages.length === 0) return empty;
    const contents = contentsPagesOf(pages);
    const first = collect(pages, contents, false);
    if (first.cands.length > MAX_CANDIDATES) return { entries: [], contentsPages: [...contents] };
    const stmtPages = statementPages(pages, contents);

    // Items
    const itemC = first.cands.filter((c) => c.kind === "item");
    let itemIdx = chain(itemC);
    // a page that holds most of the chosen entries is a list, not the headings: treat it as contents and rebuild
    const perPage = new Map<number, number>();
    for (const i of itemIdx) perPage.set(itemC[i].page, (perPage.get(itemC[i].page) ?? 0) + 1);
    const crowded = [...perPage].filter(([, n]) => n >= 8 || (itemIdx.length >= 6 && n > itemIdx.length / 2)).map(([p]) => p);
    let allSkip = contents;
    let cands = first.cands;
    if (crowded.length) {
      allSkip = new Set([...contents, ...crowded]);
      cands = collect(pages, allSkip, false).cands;
    }
    const itemCands = cands.filter((c) => c.kind === "item");
    itemIdx = chain(itemCands);
    let items = itemIdx.map((i) => itemCands[i]);
    if (items.length < 3) items = [];
    // the same Item id again after the chain moved on, with no Part heading between: the Parts cannot be told apart
    for (const it of items) {
      const reuse = itemCands.find((c) => c.num === it.num && c.letter === it.letter && c.part === it.part && c.page >= it.page + 2 && !items.includes(c));
      if (reuse && items.some((o) => o.page > it.page && o.page < reuse.page && less(keyOf(it), keyOf(o)))) {
        items = [];
        break;
      }
    }
    // a heading without an inline title takes the title of the same Item on the same page
    for (const it of items) if (!it.title) it.title = itemCands.find((c) => c.page === it.page && c.num === it.num && c.letter === it.letter && c.title)?.title ?? "";

    // Notes: "Note N" if that series exists, else "N. Title" after the first statement page
    const firstStmt = Math.min(Infinity, ...[...stmtPages.values()].flat());
    const noteSeries = (cs: Cand[]): Cand[] => {
      const idx = chain(cs).map((i) => cs[i]);
      const last = idx[idx.length - 1]?.num ?? 0;
      return idx.length >= 3 && idx[0].num === 1 && idx.length >= 0.8 * last ? idx : [];
    };
    let notes = noteSeries(cands.filter((c) => c.kind === "note"));
    if (notes.length === 0) {
      const numbered = collect(pages, allSkip, true).cands.filter((c) => c.kind === "numbered" && c.page > firstStmt);
      notes = noteSeries(numbered);
    }

    // Statements stand together, directly before the Notes
    const stmts: OutlineEntry[] = [];
    const note1 = notes[0]?.page;
    const lastOf = (ps: number[]) => (note1 === undefined ? ps[ps.length - 1] : ps.filter((p) => p < note1).pop());
    const picked = [...stmtPages].flatMap(([id, ps]) => {
      const p = lastOf(ps);
      return p === undefined ? [] : [{ id, page: p }];
    });
    if (picked.length) {
      const top = Math.max(...picked.map((s) => s.page));
      const lo = Math.min(...picked.map((s) => s.page));
      const ok = note1 !== undefined ? note1 - top <= 3 : picked.length >= 3 && top - lo <= 12;
      if (ok) for (const s of picked) if (s.page >= top - 11) stmts.push({ kind: "statement", id: s.id, title: "", from: s.page });
    }
    stmts.sort((a, b) => a.from - b.from);

    // Entries with ranges
    const multi = items.some((a, i) => items.some((b, j) => j > i && a.num === b.num && a.letter === b.letter));
    const blockStart = Math.min(...stmts.map((s) => s.from), note1 ?? Infinity);
    const entries: OutlineEntry[] = [];
    const endBefore = (nextPage: number, nextLine: number) => (nextLine < 4 ? nextPage - 1 : nextPage);
    items.forEach((it, k) => {
      const next = items[k + 1];
      let to: number;
      let stop: [number, number];
      if (next) {
        to = Math.max(it.page, endBefore(next.page, next.line));
        stop = [next.page, next.line];
      } else if (blockStart !== Infinity && blockStart > it.page) {
        to = blockStart - 1;
        stop = [blockStart, 0];
      } else {
        to = pages.length;
        stop = [pages.length, Infinity];
      }
      const lines = countLines(pages, it.page, it.line, stop[0], stop[1]);
      const id = `${multi && it.part > 0 ? `Part ${["", "I", "II", "III", "IV"][it.part]} ` : ""}Item ${it.num}${it.letter}`;
      entries.push({ kind: "item", id, title: it.title, from: it.page, to, brief: lines < 12 });
    });
    entries.push(...stmts);
    notes.forEach((n, k) => {
      const next = notes[k + 1];
      const after = items.find((i) => i.page > n.page);
      let to: number | undefined;
      if (next) to = Math.max(n.page, endBefore(next.page, next.line));
      else if (after) to = Math.max(n.page, endBefore(after.page, after.line));
      entries.push({ kind: "note", id: `Note ${n.num}`, title: n.title, from: n.page, to });
    });

    // self-check: every page inside the file and ranges ascending; a kind that fails is dropped
    const sane = (es: OutlineEntry[]) => es.every((e, i) => e.from >= 1 && e.from <= pages.length && (e.to === undefined || (e.to >= e.from && e.to <= pages.length)) && (i === 0 || e.from >= es[i - 1].from));
    const kept = (["item", "statement", "note"] as const).flatMap((k) => {
      const es = entries.filter((e) => e.kind === k);
      return sane(es) ? es : [];
    });
    return { entries: kept, contentsPages: [...contents].sort((a, b) => a - b) };
  } catch {
    return empty;
  }
}

const memo = new WeakMap<readonly string[], Outline>();
/** The outline of a parsed document, built on first use and kept with it (never stored). */
export function outlineOf(pages: readonly string[]): Outline {
  let o = memo.get(pages);
  if (!o) {
    o = buildOutline(pages);
    memo.set(pages, o);
  }
  return o;
}
export const hasOutline = (pages: readonly string[]) => memo.has(pages);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9. ]+/g, " ").replace(/\.(?=\s|$)/g, "").replace(/\s+/g, " ").trim();

/** An entry by id ("item 7", "7A", "note 6", "part ii item 1a") or by the one entry whose title holds every word given. */
export function findSection(o: Outline, name: string): OutlineEntry | undefined {
  const n = norm(name);
  if (!n) return undefined;
  const m = /^(?:part (i{1,3}|iv) )?(?:(item|note) )?(\d+(?:\.\d+)?)\s?([a-z])?$/.exec(n);
  if (m) {
    const kind = m[2] === "note" ? "note" : "item";
    const want = `${kind === "note" ? "note" : "item"} ${m[3]}${(m[4] ?? "").toLowerCase()}`;
    const hits = o.entries.filter((e) => e.kind === kind && norm(e.id).replace(/^part (?:i{1,3}|iv) /, "") === want);
    if (m[1]) return hits.find((e) => norm(e.id).startsWith(`part ${m[1]} `));
    return hits[0];
  }
  const words = n.split(" ");
  const hits = o.entries.filter((e) => e.title && words.every((w) => norm(e.title + " " + e.id).includes(w)));
  return hits.length === 1 ? hits[0] : undefined;
}

export function sectionAt(o: Outline, page: number): OutlineEntry | undefined {
  return o.entries.find((e) => e.kind !== "statement" && page >= e.from && page <= (e.to ?? e.from));
}

const cut = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s);
const range = (e: OutlineEntry) => (e.to !== undefined && e.to > e.from ? `p.${e.from}-${e.to}` : `p.${e.from}`);

/** The outline as text, one entry per line; titles are cut (34 characters, then 22) so entries are never dropped. */
export function formatOutline(o: Outline, path: string, pageCount: number, maxChars = OUTLINE_CHARS): string {
  const head = `[outline of ${path}, pages 1-${pageCount}; p. is the page of the file]`;
  if (o.entries.length === 0) return `[outline of ${path}, pages 1-${pageCount}]\nNo outline found: this file has no Item, statement or Note headings that could be placed. Use search.`;
  const body = (t: number) => o.entries.map((e) => `${e.id}${e.title ? " " + cut(e.title, t) : ""} ${range(e)}${e.brief ? " (brief)" : ""}`).join("\n");
  let text = body(34);
  if (head.length + text.length > maxChars) text = body(22);
  return `${head}\n${text}\n[a map, not a source: read pages with read_page; search inside one section with section, such as "Item 7"]`;
}

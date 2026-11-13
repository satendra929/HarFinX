// Rebuilds readable text rows from the positioned text items of one PDF page. Pure: no PDF library, no I/O.
// Financial statements are tables, and a table is only readable if each label stays on one row with its values.
// What this handles (all seen in real filings):
//  - a label and its values whose baselines differ by a fraction of a point: rows are clustered by a tolerance, not
//    rounded onto a grid (a grid splits such pairs when they straddle a bucket edge);
//  - a lone "$", "(" in front of a number and a lone "%" or ")" after one: joined, so "(473)" and "$1,671" are one token;
//  - a footnote mark right after a number: kept apart, so "2,278" and "(1)" never fuse into one figure;
//  - wide horizontal gaps: cell separator "  |  ".

export interface TextItem {
  str: string;
  x: number; // left edge
  y: number; // baseline (larger = higher on the page)
  width: number;
  height: number;
}

const CELL_SEPARATOR = "  |  ";
const CURRENCY = /^[$€£¥]$/;
const PREFIXES = /^[$€£¥(]$/;
const SUFFIXES = /^[%)]$/;

const median = (xs: number[]): number => {
  if (xs.length === 0) return 10;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

interface Cell {
  str: string;
  x: number;
  end: number;
  height: number;
}

/** The text of one page, one row per line. */
export function itemsToText(items: TextItem[]): string {
  const real = items.filter((i) => typeof i.str === "string" && i.str.trim() !== "" && Number.isFinite(i.x) && Number.isFinite(i.y));
  if (real.length === 0) return "";
  const typical = median(real.map((i) => i.height).filter((h) => h > 0));
  const rowTolerance = Math.min(4, Math.max(1.5, 0.5 * typical));
  const cellGap = Math.max(8, 1.5 * typical);
  // In statements a currency sign sits at the left of its column while the number is right-aligned, so it can be a
  // whole column width away from its number (but it still belongs to the next number on the row).
  const currencyGap = Math.max(60, 8 * typical);

  // 1. cluster into rows: top to bottom, an item joins the current row while it is within the tolerance of the row's
  //    first (highest) item
  const sorted = [...real].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: TextItem[][] = [];
  let anchor = Infinity;
  for (const it of sorted) {
    if (rows.length === 0 || anchor - it.y > rowTolerance) {
      rows.push([it]);
      anchor = it.y;
    } else rows[rows.length - 1].push(it);
  }

  // 2. per row, left to right: glue lone prefixes and suffixes to their number, then join with spaces or separators
  const lines: string[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    const cells: Cell[] = [];
    let pending: Cell | undefined; // a lone "$" or "(" waiting for the number after it
    for (const it of row) {
      const cell: Cell = { str: it.str.trim(), x: it.x, end: it.x + it.width, height: it.height };
      if (pending) {
        const gap = cell.x - pending.end;
        if (CURRENCY.test(pending.str) ? gap < currencyGap && /^[(\d.,-]/.test(cell.str) : gap < cellGap) {
          cell.str = pending.str + cell.str;
          if (!CURRENCY.test(pending.str)) cell.x = pending.x; // a currency sign does not move the number's column position
        } else cells.push(pending);
        pending = undefined;
      }
      const prev = cells[cells.length - 1];
      if (SUFFIXES.test(cell.str) && prev && cell.x - prev.end < cellGap) {
        prev.str += cell.str;
        prev.end = cell.end;
        continue;
      }
      if (PREFIXES.test(cell.str)) {
        pending = cell;
        continue;
      }
      cells.push(cell);
    }
    if (pending) cells.push(pending);

    let line = "";
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (i > 0) {
        const p = cells[i - 1];
        const gap = c.x - p.end;
        if (gap >= cellGap) line += CELL_SEPARATOR;
        else if (gap > 1 || (c.height < 0.8 * typical && /\d$/.test(p.str))) line += " "; // small text after a number: a footnote mark
      }
      line += c.str;
    }
    if (line.trim()) lines.push(line.trim());
  }
  return lines.join("\n");
}

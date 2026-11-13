// Page search inside one document: plain keyword ranking (BM25) over page texts, with a bonus for query words that
// appear next to each other. Deterministic, local, no model and no embeddings. Pure: no I/O.

export interface PageHit {
  page: number; // counting from 1
  score: number;
  title: string; // the first heading-like line of the page
  snippet: string; // the line that best matches the query
}

export interface PageIndex {
  pages: number;
  search(query: string, k?: number): PageHit[];
}

// Words that carry no information about where an answer is printed: grammar, question words and instruction verbs.
const STOP = new Set(
  (
    "a an and are as at be by for from has have in is it its of on or that the this to was were with " +
    "what which who whom why when where how does did do much many any there their between among during " +
    "please state explain define answer respond assume based reasonably given using use"
  ).split(" "),
);
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const SNIPPET_CHARS = 200;

/**
 * A light stem, applied to page words and query words alike, so that related forms meet: plurals, -ing/-ed/-ly,
 * and a few derivational endings ("cyclicality" and "cyclical", "operation" and "operating"). It folds, it does not
 * understand: unrelated words may rarely collide, and that is the price of not needing a dictionary.
 */
export function stem(word: string): string {
  let t = word;
  if (t.length > 4 && /(?:ss|x|z|ch|sh)es$/.test(t)) t = t.slice(0, -2); // businesses -> business, taxes -> tax
  else if (t.length > 4 && t.endsWith("ies")) t = t.slice(0, -3) + "y"; // liabilities -> liability
  else if (t.length > 3 && t.endsWith("s") && !/(?:ss|us|is)$/.test(t)) t = t.slice(0, -1); // assets -> asset
  if (t.length > 6 && t.endsWith("ation")) t = t.slice(0, -5) + "at"; // operation -> operat (as operate and operating)
  else if (t.length > 5 && t.endsWith("ity")) t = t.slice(0, -3); // liquidity -> liquid
  else if (t.length > 6 && t.endsWith("ing")) t = t.slice(0, -3); // operating -> operat (short words such as filing stay)
  else if (t.length > 4 && t.endsWith("ed")) t = t.slice(0, -2); // reported -> report
  else if (t.length > 5 && t.endsWith("ly")) t = t.slice(0, -2); // significantly -> significant
  if (t.length > 4 && t.endsWith("e")) t = t.slice(0, -1); // operate -> operat, increase -> increas
  return t;
}

/**
 * Lower case words and numbers; "19,815" and "19815" are one token; abbreviations with & stay whole ("SG&A" is
 * "sga", as printed and as typed); stop words dropped; words stemmed.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/\d[\d,]*(?:\.\d+)?|[a-z]+(?:&[a-z]+)+|[a-z][a-z'-]*/g) ?? []) {
    let t = raw.replace(/,/g, "").replace(/'s$/, "").replace(/^-+|-+$/g, "").replace(/&/g, "");
    if (!t || STOP.has(t)) continue;
    if (/^[a-z]/.test(t)) t = stem(t);
    out.push(t);
  }
  return out;
}

const HEADING_LINES = 3;
const HEADING_WEIGHT = 1.0;

/** The first few lines that look like headings: have letters, are short, and are not navigation. */
export function headingLines(text: string, max = HEADING_LINES): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const l = line.split("|")[0].trim();
    if (!l || l.length > 100 || !/[A-Za-z]{3}/.test(l)) continue;
    if (/^(table of contents|index)$/i.test(l)) continue;
    out.push(l);
    if (out.length === max) break;
  }
  return out;
}

/** A short title for a page: its heading lines joined. */
export function pageTitle(text: string): string {
  const t = headingLines(text).join(" / ");
  return t.length > 90 ? t.slice(0, 89) + "…" : t;
}

export function buildIndex(pageTexts: string[]): PageIndex {
  const docs = pageTexts.map((text) => {
    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const pairs = new Set<string>();
    for (let i = 1; i < tokens.length; i++) pairs.add(tokens[i - 1] + " " + tokens[i]);
    const heading = new Set(tokenize(headingLines(text).join(" ")));
    return { text, length: tokens.length, tf, pairs, heading };
  });
  const n = docs.length;
  const avgLength = n ? docs.reduce((a, d) => a + d.length, 0) / n || 1 : 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));

  return {
    pages: n,
    search(query, k = 5) {
      const terms = [...new Set(tokenize(query))];
      if (terms.length === 0) return [];
      const qTokens = tokenize(query);
      const qPairs = [...new Set(qTokens.slice(1).map((t, i) => qTokens[i] + " " + t))];
      const hits: PageHit[] = [];
      docs.forEach((d, i) => {
        let score = 0;
        for (const t of terms) {
          const f = d.tf.get(t);
          if (!f) continue;
          score += idf(t) * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * d.length) / avgLength)));
        }
        if (score === 0) return;
        // A statement names itself once, in its heading; prose pages repeat the same words. Heading words count extra.
        for (const t of terms) if (d.heading.has(t)) score += HEADING_WEIGHT * idf(t);
        for (const p of qPairs) if (d.pairs.has(p)) score += 0.5 * (idf(p.split(" ")[0]) + idf(p.split(" ")[1])) / 2; // words side by side
        hits.push({ page: i + 1, score, title: pageTitle(d.text), snippet: bestLine(d.text, terms) });
      });
      return hits.sort((a, b) => b.score - a.score || a.page - b.page).slice(0, Math.max(0, k));
    },
  };
}

/** The line with the most distinct query terms (first one on ties), cut to SNIPPET_CHARS. */
function bestLine(text: string, terms: string[]): string {
  let best = "";
  let bestCount = 0;
  for (const line of text.split("\n")) {
    const toks = new Set(tokenize(line));
    const count = terms.filter((t) => toks.has(t)).length;
    if (count > bestCount) {
      best = line.trim();
      bestCount = count;
    }
  }
  return best.length > SNIPPET_CHARS ? best.slice(0, SNIPPET_CHARS - 1) + "…" : best;
}

// Citing the figures of an answer: a quote points to the row it was printed on, a calculation to its formula, its printed
// operands and the rows they were read from. The harness decides this from what the model was shown and what the
// calculator returned; the model is not involved. Pure: no I/O.
//
// A figure is exactly one of: exempt (a year, list number, constant, name), from the question, a quote, a calculation, or
// uncited (it could not be traced: it gets no mark). "Cited" means traceable to a printed number, not correct: the
// row, the period and the definition are still the reader's to check.
import { extractNumbers, isNonFigure, normalise, type CalcRec, type Ledger, type NumToken } from "./provenance.ts";
import { FUNCTION_MAP } from "./calc/functions.ts";
import { namesOf, parse, printNode, substitute, timesHundred, type Node } from "./calc/parse.ts";
import { buildSources, CLOSING_LINE, DEFAULT_SOURCE_LIMITS, formatEntryLines, looksLikeName, placeKey, placesOf, sourcesForAudit, type FormatOptions, type Located, type SourcesResult } from "./sources.ts";
import { oneLine } from "./feedback.ts";
import { tokenize } from "./documents/search.ts";
import { nearestHeader } from "./documents/pages.ts";
import type { Decision } from "./refs.ts";

export type OperandHow = "page" | "question" | "calc" | "constant";
export interface Operand {
  name: string;
  literal: string;
  how: OperandHow;
  rec?: Located;
  step?: CalcRec;
}

export type Cited =
  | { kind: "exempt" }
  | { kind: "question" }
  | { kind: "quote"; recs: Located[]; keys: string[] }
  | { kind: "calc"; step: CalcRec; operands: Operand[]; keys: string[] }
  | { kind: "uncited"; reason: string };

export const calcKey = (s: CalcRec): string => `calc:${s.meta?.call ?? 0}:${s.name}`;

const MAX_DEPTH = 3;

// ---- which step produced a figure --------------------------------------------------------------------

/** A figure equals a step's shown text: same digits, same decimals, a percent only for a percent (or an expression that multiplies by 100). */
function shownEquals(t: NumToken, step: CalcRec): boolean {
  const s = extractNumbers(normalise(step.shown))[0];
  if (!s || t.canon !== s.canon || t.decimals !== s.decimals) return false;
  if (t.percent === s.percent) return true;
  if (!t.percent || s.percent) return false; // a plain number is never a percent figure's twin ("11.3" for "11.3%")
  try {
    return step.meta !== undefined && timesHundred(parse(step.meta.expr)); // "11.3%" for a plain 11.3 that the expression itself multiplied by 100
  } catch {
    return false;
  }
}

/** The step a figure of the answer quotes: the last whose shown text equals it. */
export function stepFor(t: NumToken, ledger: Ledger): CalcRec | undefined {
  const found = ledger.calcRecs.filter((c) => shownEquals(t, c));
  return found[found.length - 1];
}

// ---- which row, when a value is printed on several ---------------------------------------------------

/** The words around a figure: the sentence it is in, and the question (tried second, when the sentence names nothing). */
export interface CiteContext {
  sentence?: string;
  question?: string;
}

const YEAR = /\b(?:19|20)\d\d\b/g;
const labelOf = (row: string): string => (/[A-Za-z]{2}/.test(row.split("|")[0]) ? row.split("|")[0] : row);

function rowScore(rec: Located, hint: string): number {
  const words = new Set(tokenize(hint));
  let score = tokenize(labelOf(rec.where.row)).filter((w) => words.has(w)).length;
  const years = hint.match(YEAR) ?? [];
  for (const y of new Set(years)) if (rec.where.row.includes(y)) score++;
  return score;
}

/**
 * The rows a figure is most likely cited to: those whose label (and year) share the most with the words around it, at
 * most two distinct rows; when no row shares anything with the first hint, the next hint is tried; when nothing
 * discriminates, every row stays (the closing line tells the reader to check the row).
 */
export function narrowRecs(recs: readonly Located[], hints: readonly (string | undefined)[]): Located[] {
  const distinct = new Set(recs.map((r) => `${placeKey(r.where)}|${r.where.row}`));
  if (distinct.size <= 1) return [...recs];
  for (const hint of hints) {
    if (!hint) continue;
    const scored = recs.map((r) => ({ r, s: rowScore(r, hint) }));
    const best = Math.max(...scored.map((x) => x.s));
    if (best <= 0) continue;
    const top = scored.filter((x) => x.s === best).map((x) => x.r);
    const rows: string[] = [];
    return top.filter((r) => {
      const k = `${placeKey(r.where)}|${r.where.row}`;
      if (!rows.includes(k)) rows.push(k);
      return rows.indexOf(k) < 2;
    });
  }
  return [...recs];
}

// ---- the page's unit against the figure's scale word ---------------------------------------------------

const SCALE_WORDS: [RegExp, string][] = [
  [/\bthousands?\b/i, "thousand"],
  [/\bmillions?\b/i, "million"],
  [/\bbillions?\b/i, "billion"],
];

/** The one scale a units line states ("(in millions, except per share)"): nothing when it names none or several. */
export function unitScale(units: string | undefined): string | undefined {
  if (!units) return undefined;
  const found = SCALE_WORDS.filter(([re]) => re.test(units)).map(([, w]) => w);
  return found.length === 1 ? found[0] : undefined;
}

/** Whether the page row's unit contradicts the scale word the answer wrote: only table rows, only one stated scale, and not when the source figure has its own scale word. */
function scaleConflict(t: NumToken, rec: Located): boolean {
  if (!t.scale || rec.scale || !rec.where.row.includes("|") || !rec.where.pageLines || rec.where.lineNo === undefined) return false;
  const page = unitScale(nearestHeader(rec.where.pageLines, rec.where.lineNo).units);
  return page !== undefined && page !== t.scale;
}

// ---- operands -----------------------------------------------------------------------------------------

type Resolved = { ok: true; operands: Operand[]; keys: string[] } | { ok: false; reason: string };

function singleToken(text: string): NumToken | undefined {
  const toks = extractNumbers(normalise(text));
  return toks.length === 1 ? toks[0] : undefined;
}

/** What one printed number (an input or a literal of an expression) was read from. */
function resolveNumber(name: string, literal: string, step: CalcRec, ledger: Ledger, depth: number, ctx: CiteContext): { operand: Operand; keys: string[] } | string {
  const t = singleToken(literal);
  if (!t) return `"${name}" is not a single number`;
  if (isNonFigure(t)) return { operand: { name, literal, how: "constant" }, keys: [] };
  const recs = ledger.findAll(t);
  const located = recs.filter((r): r is Located => r.where !== undefined);
  if (located.length) {
    const rec = narrowRecs(located, [`${name.replace(/_/g, " ")} ${step.name.replace(/_/g, " ")} ${ctx.sentence ?? ""}`, ctx.question])[0];
    return { operand: { name, literal, how: "page", rec }, keys: [placeKey(rec.where)] };
  }
  if (recs.some((r) => r.origin === "U")) return { operand: { name, literal, how: "question" }, keys: [] };
  const earlier = ledger.calcRecs.find((c) => c !== step && shownEquals(t, c));
  if (earlier && depth < MAX_DEPTH) {
    const inner = resolveStep(earlier, ledger, depth + 1, ctx);
    if (inner.ok) return { operand: { name, literal, how: "calc", step: earlier }, keys: [calcKey(earlier), ...inner.keys] };
  }
  return `${name} = ${oneLine(literal, 30)} was not printed on a page read, in the question or in an earlier calculation`;
}

/** Every number a step uses must resolve: inputs, numbers written in the expression (except plain constants) and earlier steps of the same call. */
export function resolveStep(step: CalcRec, ledger: Ledger, depth = 0, ctx: CiteContext = {}): Resolved {
  const meta = step.meta;
  if (!meta) return { ok: false, reason: "no record of how the calculation was written" };
  let tree: Node;
  try {
    tree = parse(meta.expr);
  } catch {
    return { ok: false, reason: "the expression could not be read back" };
  }
  const inputs = new Map(meta.inputs.map((i) => [i.name, i.literal]));
  const sameCall = ledger.stepsOfCall(meta.call);
  const operands: Operand[] = [];
  const keys: string[] = [];
  const seen = new Set<string>();
  const failures: string[] = [];

  const visitStep = (s: CalcRec, d: number): void => {
    if (seen.has(s.name)) return;
    seen.add(s.name);
    const m = s.meta;
    if (!m) return;
    const t = parse(m.expr);
    for (const n of namesOf(t)) {
      const lit = inputs.get(n);
      if (lit !== undefined) {
        if (operands.some((o) => o.name === n)) continue;
        const r = resolveNumber(n, lit, step, ledger, depth, ctx);
        if (typeof r === "string") failures.push(r);
        else {
          operands.push(r.operand);
          keys.push(...r.keys);
        }
      } else {
        const prior = sameCall.get(n);
        if (prior && prior !== s && d < MAX_DEPTH) visitStep(prior, d + 1);
        else failures.push(`"${n}" is not an input or an earlier step`);
      }
    }
    for (const lit of m.literals) {
      const r = resolveNumber("(in the expression)", lit, step, ledger, depth, ctx);
      if (typeof r === "string") failures.push(r);
      else {
        operands.push(r.operand);
        keys.push(...r.keys);
      }
    }
  };
  visitStep(step, 0);
  return failures.length ? { ok: false, reason: failures[0] } : { ok: true, operands, keys: [...new Set(keys)] };
}

// ---- the decision for one figure ---------------------------------------------------------------------

/** Years, list numbers, constants and names are not figures; a percent is never cited to a source number printed with a currency sign. */
function quoteRecs(t: NumToken, ledger: Ledger, ctx: CiteContext): { recs: Located[]; keys: string[] } | { conflict: true } | undefined {
  const found = placesOf(t, ledger);
  if (!found) return undefined;
  const typed = found.recs.filter((r) => !(t.percent && !r.percent && /^[\s(]*[$€£]/.test(r.raw)));
  if (!typed.length) return undefined;
  const agreeing = typed.filter((r) => !scaleConflict(t, r));
  if (!agreeing.length) return { conflict: true }; // every row prints it in another unit than the answer's scale word
  const recs = narrowRecs(agreeing, [ctx.sentence, ctx.question]);
  return { recs, keys: [...new Set(recs.map((r) => placeKey(r.where)))] };
}

export function citeFigure(t: NumToken, ledger: Ledger, ctx: CiteContext = {}): Cited {
  if (isNonFigure(t) || looksLikeName(t)) return { kind: "exempt" };
  // A figure equal to a calculation's shown value is that calculation, even when the same digits sit on a page row.
  const step = stepFor(t, ledger);
  if (step) {
    const r = resolveStep(step, ledger, 0, ctx);
    if (!r.ok) return { kind: "uncited", reason: r.reason };
    return { kind: "calc", step, operands: r.operands, keys: [calcKey(step), ...r.keys] };
  }
  const q = quoteRecs(t, ledger, ctx);
  if (q && "conflict" in q) return { kind: "uncited", reason: "the page prints it in another unit than the scale word written" };
  if (q) return { kind: "quote", recs: q.recs, keys: q.keys };
  if (ledger.findAll(t).some((r) => r.origin === "U")) return { kind: "question" };
  return { kind: "uncited", reason: "not printed on a page read, not in the question and not from the calculator" };
}

// ---- the calculation entry ---------------------------------------------------------------------------

const FORMULA_CHARS = 90;
const MAX_WHERE = 2;

/** An input's literal as it reads in a formula: a printed negative `(473)` becomes `(-473)`. */
function literalText(literal: string): string {
  const t = literal.trim();
  const neg = /^\(\s*([^()]+?)\s*\)$/.exec(t);
  return neg ? `(-${neg[1]})` : t;
}

export interface Formula {
  /** `shown = expression`, inputs replaced by their printed numbers. */
  text: string;
  /** `where name = expression` for earlier steps kept by name when the whole formula is too long. */
  where: string[];
  /** `sig = definition` of each function the formula calls. */
  definitions: string[];
}

export function formulaOf(step: CalcRec, ledger: Ledger): Formula {
  const meta = step.meta;
  const none: Formula = { text: `${step.shown}`, where: [], definitions: [] };
  if (!meta) return none;
  const inputs = new Map(meta.inputs.map((i) => [i.name, literalText(i.literal)]));
  const sameCall = ledger.stepsOfCall(meta.call);
  const treeOf = (s: CalcRec): Node => parse(s.meta!.expr);
  try {
    // Fully inlined: each earlier step replaced by its own expression (parentheses come from the tree).
    const inline = (s: CalcRec, d: number): Node => substitute(treeOf(s), (n) => (inputs.has(n) ? inputs.get(n) : (sameCall.get(n) && sameCall.get(n) !== s && sameCall.get(n)!.meta && d < MAX_DEPTH ? inline(sameCall.get(n)!, d + 1) : undefined)));
    const full = printNode(inline(step, 0));
    const calls = new Set<string>();
    const collect = (s: CalcRec, d: number): void => {
      s.meta?.calls.forEach((c) => calls.add(c));
      for (const n of namesOf(treeOf(s))) {
        const prior = sameCall.get(n);
        if (prior && prior !== s && prior.meta && d < MAX_DEPTH) collect(prior, d + 1);
      }
    };
    collect(step, 0);
    const definitions = [...calls].map((c) => FUNCTION_MAP.get(c)).filter((f) => f !== undefined).map((f) => `${f.sig} = ${f.definition}`);
    if (full.length <= FORMULA_CHARS) return { text: `${step.shown} = ${full}`, where: [], definitions };
    // Too long: keep the names of earlier steps and say what each is.
    const byInputs = (s: CalcRec): string => printNode(substitute(treeOf(s), (n) => inputs.get(n)));
    const referenced = namesOf(treeOf(step)).map((n) => sameCall.get(n)).filter((s): s is CalcRec => !!s && s !== step && !!s.meta);
    const where = referenced.slice(0, MAX_WHERE).map((s) => `where ${s.name} = ${oneLine(byInputs(s), FORMULA_CHARS)}`);
    return { text: `${step.shown} = ${oneLine(byInputs(step), FORMULA_CHARS)}`, where, definitions };
  } catch {
    return none;
  }
}

export interface CalcEntry {
  /** The reference number of the entry. */
  ref: number;
  step: CalcRec;
  /** Reference numbers of the entries its operands were read from (pages and earlier calculations). */
  inputsFrom: number[];
}

/** The lines of one calculation entry. */
export function calcEntryLines(e: CalcEntry, ledger: Ledger): string[] {
  const f = formulaOf(e.step, ledger);
  const from = e.inputsFrom.length ? `   inputs from ${e.inputsFrom.map((n) => `[${n}]`).join("")}` : "";
  const lines = [`  [${e.ref}]  ${f.text}${from}`];
  for (const w of f.where) lines.push(`    ${w}`);
  for (const d of f.definitions) lines.push(`    ${oneLine(d, 110)}`);
  return lines;
}

// ---- the list under the answer ------------------------------------------------------------------------

export interface CitationList {
  lines: string[];
  sources: SourcesResult;
  calcEntries: CalcEntry[];
}

/** The page operands of a calculation, and of the earlier calculations it was built from. */
function pageOperands(operands: readonly Operand[], ledger: Ledger, depth = 0): Operand[] {
  const out: Operand[] = [];
  for (const o of operands) {
    if (o.how === "page") out.push(o);
    else if (o.how === "calc" && o.step && depth < MAX_DEPTH) {
      const inner = resolveStep(o.step, ledger, depth + 1);
      if (inner.ok) out.push(...pageOperands(inner.operands, ledger, depth + 1));
    }
  }
  return out;
}

/**
 * The entries under the answer, built from the decisions the marks were made from, so the list holds exactly what the
 * marks and the formulas point at: the rows each marked quote and each operand was cited to, and one entry per marked
 * calculation, in their reference numbers.
 */
export function buildCitationList(decisions: readonly Decision[], order: readonly string[], ledger: Ledger, link?: FormatOptions["link"]): CitationList {
  const chosen = new Map<string, Located[]>();
  const add = (raw: string, recs: readonly Located[]): void => {
    const have = chosen.get(raw) ?? [];
    chosen.set(raw, [...have, ...recs.filter((r) => !have.includes(r))]);
  };
  const figures: NumToken[] = [];
  const inputs: NumToken[] = [];
  const steps = new Map<string, CalcRec>();
  for (const d of decisions) {
    if (d.numbers.length === 0) continue; // only figures that carry a mark
    if (d.cited.kind === "quote") {
      figures.push(d.token);
      add(d.token.raw, d.cited.recs);
    } else if (d.cited.kind === "calc") {
      steps.set(calcKey(d.cited.step), d.cited.step);
      for (const o of d.cited.operands) if (o.how === "calc" && o.step) steps.set(calcKey(o.step), o.step);
      for (const o of pageOperands(d.cited.operands, ledger)) {
        const t = singleToken(o.literal);
        if (t && o.rec) {
          inputs.push(t);
          add(t.raw, [o.rec]);
        }
      }
    }
  }
  const sources = buildSources(figures, inputs, ledger, order, DEFAULT_SOURCE_LIMITS, chosen);
  const numberOf = (key: string): number | undefined => (order.includes(key) ? order.indexOf(key) + 1 : undefined);
  const calcEntries: CalcEntry[] = [];
  for (const [key, step] of steps) {
    const ref = numberOf(key);
    if (ref === undefined) continue;
    const r = resolveStep(step, ledger);
    const from = r.ok ? r.keys.filter((k) => k !== key).map(numberOf).filter((n): n is number => n !== undefined) : [];
    calcEntries.push({ ref, step, inputsFrom: [...new Set(from)] });
  }
  const items = [
    ...sources.entries.map((e) => ({ ref: e.ref, lines: formatEntryLines(e, { link }) })),
    ...calcEntries.map((c) => ({ ref: c.ref, lines: calcEntryLines(c, ledger) })),
  ].sort((a, b) => a.ref - b.ref);
  const lines: string[] = [];
  if (items.length || sources.many.length) {
    for (const i of items) lines.push(...i.lines);
    for (const m of sources.many) lines.push(`  ${oneLine(m.figure, 30)} appears on ${m.pages} pages; not listed`);
    if (sources.moreEntries > 0) lines.push(`  and ${sources.moreEntries} more page${sources.moreEntries === 1 ? "" : "s"}`);
    lines.push(CLOSING_LINE);
  }
  return { lines, sources, calcEntries };
}

/** A compact record of every figure decision, for the audit log. */
export function citationsForAudit(decisions: readonly Decision[], limit = 60): Record<string, unknown>[] {
  return decisions.slice(0, limit).map((d) => ({
    figure: d.token.raw,
    kind: d.cited.kind,
    marks: d.numbers,
    ...(d.cited.kind === "calc" ? { step: d.cited.step.name, call: d.cited.step.meta?.call, operands: d.cited.operands.map((o) => ({ name: o.name, literal: o.literal, how: o.how, ...(o.rec ? { file: o.rec.where.file, page: o.rec.where.page } : {}) })) } : {}),
    ...(d.cited.kind === "uncited" ? { reason: d.cited.reason } : {}),
    ...(d.note ? { note: d.note } : {}),
  }));
}

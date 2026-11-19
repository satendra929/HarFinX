// Tiny expression language for the calculator. Hand-written, no eval, no Function.
//   expr   := term (("+" | "-") term)*
//   term   := unary (("*" | "/") unary)*
//   unary  := "-" unary | power
//   power  := atom ("^" unary)?           (right associative)
//   atom   := NUMBER | NAME | NAME "(" [expr ("," expr)*] ")" | "(" expr ")"
// Numbers are plain decimals (no commas, no exponents): source numbers go in `inputs`, not in expressions.
import { CalcError } from "./num.ts";

export const LIMITS = { maxExprChars: 400, maxTokens: 200, maxDepth: 30 };

export type Node =
  | { t: "num"; v: string }
  | { t: "name"; name: string; pos: number }
  | { t: "neg"; x: Node }
  | { t: "bin"; op: "+" | "-" | "*" | "/" | "^"; l: Node; r: Node }
  | { t: "call"; name: string; args: Node[]; pos: number };

interface Tok {
  k: "num" | "name" | "op";
  s: string;
  pos: number;
}

function tokenize(src: string): Tok[] {
  if (src.length > LIMITS.maxExprChars) throw new CalcError(`expression too long (${src.length} characters, limit ${LIMITS.maxExprChars})`);
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      if (src[j] === ".") {
        j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      // "1,233" is a thousands separator, not two arguments. Commas between arguments need a space or a different shape.
      if (/^,\d{3}(?!\d)/.test(src.slice(j))) throw new CalcError(`position ${j}: commas are not allowed inside numbers (or write a space after the comma between arguments); put source numbers in "inputs" exactly as printed and refer to them by name`);
      if (/[A-Za-z_%]/.test(src[j] ?? "")) throw new CalcError(`position ${j}: "${src[j]}" directly after a number; use * for multiplication and put units in prose`);
      toks.push({ k: "num", s: src.slice(i, j), pos: i });
      i = j;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ k: "name", s: src.slice(i, j), pos: i });
      i = j;
    } else if ("+-*/^(),".includes(c)) {
      toks.push({ k: "op", s: c, pos: i });
      i++;
    } else {
      throw new CalcError(`position ${i}: unexpected character "${c}"`);
    }
    if (toks.length > LIMITS.maxTokens) throw new CalcError(`expression too complex (more than ${LIMITS.maxTokens} tokens)`);
  }
  return toks;
}

export function parse(src: string): Node {
  const toks = tokenize(src);
  if (toks.length === 0) throw new CalcError("empty expression");
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const isOp = (s: string) => peek()?.k === "op" && peek().s === s;
  const fail = (msg: string): never => {
    throw new CalcError(`position ${peek()?.pos ?? src.length}: ${msg}`);
  };
  const enter = () => {
    if (++depth > LIMITS.maxDepth) throw new CalcError(`expression nested too deeply (limit ${LIMITS.maxDepth})`);
  };

  function expr(): Node {
    enter();
    let l = term();
    while (isOp("+") || isOp("-")) {
      const op = toks[p++].s as "+" | "-";
      l = { t: "bin", op, l, r: term() };
    }
    depth--;
    return l;
  }
  function term(): Node {
    let l = unary();
    while (isOp("*") || isOp("/")) {
      const op = toks[p++].s as "*" | "/";
      l = { t: "bin", op, l, r: unary() };
    }
    return l;
  }
  function unary(): Node {
    if (isOp("-")) {
      p++;
      enter();
      const x = unary();
      depth--;
      return { t: "neg", x };
    }
    return power();
  }
  function power(): Node {
    const base = atom();
    if (isOp("^")) {
      p++;
      enter();
      const exp = unary();
      depth--;
      return { t: "bin", op: "^", l: base, r: exp };
    }
    return base;
  }
  function atom(): Node {
    const t = peek();
    if (!t) return fail("expression ends unexpectedly");
    if (t.k === "num") {
      p++;
      return { t: "num", v: t.s };
    }
    if (t.k === "name") {
      p++;
      if (isOp("(")) {
        p++;
        const args: Node[] = [];
        if (!isOp(")")) {
          args.push(expr());
          while (isOp(",")) {
            p++;
            args.push(expr());
          }
        }
        if (!isOp(")")) fail('expected ")"');
        p++;
        return { t: "call", name: t.s, args, pos: t.pos };
      }
      return { t: "name", name: t.s, pos: t.pos };
    }
    if (isOp("(")) {
      p++;
      const e = expr();
      if (!isOp(")")) fail('expected ")"');
      p++;
      return e;
    }
    return fail(`unexpected "${t.s}"`);
  }

  const tree = expr();
  if (p < toks.length) fail(`unexpected "${toks[p].s}"`);
  return tree;
}

/** Numeric literals written inside an expression (for the provenance check). */
export function literalsOf(n: Node, out: string[] = []): string[] {
  if (n.t === "num") out.push(n.v);
  else if (n.t === "neg") literalsOf(n.x, out);
  else if (n.t === "bin") {
    literalsOf(n.l, out);
    literalsOf(n.r, out);
  } else if (n.t === "call") n.args.forEach((a) => literalsOf(a, out));
  return out;
}

/** Function names called in an expression. */
export function callsOf(n: Node, out: Set<string> = new Set()): Set<string> {
  if (n.t === "neg") callsOf(n.x, out);
  else if (n.t === "bin") {
    callsOf(n.l, out);
    callsOf(n.r, out);
  } else if (n.t === "call") {
    out.add(n.name);
    n.args.forEach((a) => callsOf(a, out));
  }
  return out;
}

// ---- printing --------------------------------------------------------------------------------------

const PRINT_PREC = (n: Node): number => (n.t === "bin" ? (n.op === "^" ? 4 : n.op === "*" || n.op === "/" ? 2 : 1) : n.t === "neg" ? 3 : 5);

/**
 * An expression as text, with parentheses only where precedence needs them, so a substituted sub-expression can never
 * change the meaning (`a - (b + c)` never prints as `a - b + c`). Names print as they are: replace them first with
 * `substitute`. Function arguments are separated by "; " so a comma inside a number is never ambiguous.
 */
export function printNode(n: Node): string {
  switch (n.t) {
    case "num":
      return n.v;
    case "name":
      return n.name;
    case "neg": {
      const x = printNode(n.x);
      return PRINT_PREC(n.x) < 4 ? `-(${x})` : `-${x}`;
    }
    case "call":
      return `${n.name}(${n.args.map(printNode).join("; ")})`;
    case "bin": {
      const p = PRINT_PREC(n);
      const wrapLeft = PRINT_PREC(n.l) < p || (n.op === "^" && (n.l.t === "bin" || n.l.t === "neg"));
      const wrapRight = n.r.t === "neg" || PRINT_PREC(n.r) < p || (PRINT_PREC(n.r) === p && n.op !== "^" && (n.op === "-" || n.op === "/"));
      const l = wrapLeft ? `(${printNode(n.l)})` : printNode(n.l);
      const r = wrapRight ? `(${printNode(n.r)})` : printNode(n.r);
      return n.op === "^" ? `${l}^${r}` : `${l} ${n.op} ${r}`;
    }
  }
}

/** The tree with each name node replaced by what `by` returns for it (a number text becomes a literal node; a node is used as it is); names it does not know stay. */
export function substitute(n: Node, by: (name: string) => Node | string | undefined): Node {
  switch (n.t) {
    case "num":
      return n;
    case "name": {
      const r = by(n.name);
      return r === undefined ? n : typeof r === "string" ? { t: "num", v: r } : r;
    }
    case "neg":
      return { t: "neg", x: substitute(n.x, by) };
    case "bin":
      return { t: "bin", op: n.op, l: substitute(n.l, by), r: substitute(n.r, by) };
    case "call":
      return { t: "call", name: n.name, args: n.args.map((a) => substitute(a, by)), pos: n.pos };
  }
}

/** The names an expression uses (not function names), in order of first use. */
export function namesOf(n: Node, out: string[] = []): string[] {
  if (n.t === "name") {
    if (!out.includes(n.name)) out.push(n.name);
  } else if (n.t === "neg") namesOf(n.x, out);
  else if (n.t === "bin") {
    namesOf(n.l, out);
    namesOf(n.r, out);
  } else if (n.t === "call") n.args.forEach((a) => namesOf(a, out));
  return out;
}

/** Whether the expression multiplies something by 100 (a percent worked out by hand inside the expression). */
export function timesHundred(n: Node): boolean {
  if (n.t === "bin") return (n.op === "*" && ((n.l.t === "num" && Number(n.l.v) === 100) || (n.r.t === "num" && Number(n.r.v) === 100))) || timesHundred(n.l) || timesHundred(n.r);
  if (n.t === "neg") return timesHundred(n.x);
  if (n.t === "call") return n.args.some(timesHundred);
  return false;
}

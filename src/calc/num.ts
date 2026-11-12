// Number layer of the calculator: the only file that imports decimal.js, so the library can be swapped.
// Convention: half away from zero (Excel ROUND, usual in financial reporting); precision 40 significant digits.
// Rates are fractions internally (0.05); percent is a display choice. Intermediate values are never rounded
// unless the expression calls round().
import { Decimal } from "decimal.js";

export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -80, toExpPos: 80 });
export type Num = InstanceType<typeof D>;
export const ENGINE = "decimal.js 10.6.0";
export const ROUNDING = "half away from zero";
export const MAX_ABS = new D("1e60"); // results beyond this are an error, not a number

/** A user-facing calculation error (bad input, domain error, limit). Always safe to show to the model. */
export class CalcError extends Error {}

export function checkFinite(x: Num, where: string): Num {
  if (!x.isFinite()) throw new CalcError(`${where}: result is not a finite number`);
  if (x.abs().gt(MAX_ABS)) throw new CalcError(`${where}: result is too large`);
  return x;
}

// "11,503"  "$1,233"  "(473)"  "-5.5"  "3.06%"  -> exactly one number, nothing else.
const INPUT = /^(\()?\s?[$€£]?\s?(-|−)?\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(\))?\s?(%)?$/;

/**
 * Parse a value copied from the source. Lenient about formatting ($, commas, parentheses = negative, %),
 * strict about meaning: unit words are rejected so conversion happens in the calculator, visibly.
 */
export function parseInputLiteral(literal: string, name: string): Num {
  const s = literal.trim();
  const m = INPUT.exec(s.normalize("NFKC"));
  if (!m || Boolean(m[1]) !== Boolean(m[5])) {
    const unit = /[A-Za-z]/.test(s) ? " Unit words (million, thousand, M, bn) are not accepted: copy the number exactly as printed and convert with the calculator." : "";
    throw new CalcError(`input "${name}": cannot read "${literal}" as a single number.${unit}`);
  }
  let x = new D(m[3].replace(/,/g, "") + (m[4] ?? ""));
  if (m[1] || m[2]) x = x.neg();
  if (m[6]) x = x.div(100);
  return x;
}

export function roundHalfAway(x: Num, dp: number): Num {
  return x.toDecimalPlaces(dp, D.ROUND_HALF_UP);
}

const noNegZero = (x: Num): Num => (x.isZero() ? new D(0) : x);

/** 12 significant digits, plain notation, trailing zeros trimmed. Full precision stays in the audit details. */
export function sig12(x: Num): string {
  return noNegZero(x.toSignificantDigits(12)).toFixed();
}

/**
 * What the answer should quote. dp given: fixed decimals (half away from zero). No dp: 12 significant digits for
 * plain numbers, one decimal for percentages.
 */
export function shownValue(x: Num, dp: number | undefined, pct: boolean): string {
  const v = pct ? x.times(100) : x;
  const places = dp ?? (pct ? 1 : undefined);
  const text = places === undefined ? sig12(v) : noNegZero(roundHalfAway(v, places)).toFixed(places);
  return pct ? `${text}%` : text;
}

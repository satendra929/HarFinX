// How long and how structured an answer is, as plain counts. Written to the audit log for every answer so the length and
// layout of answers can be tracked and compared between versions of the prompt or between models. It only counts: it never
// changes, blocks or comments on an answer, and it matches no wording (structure and size only). Pure.

export interface AnswerShape {
  words: number;
  /** Non-empty lines. */
  lines: number;
  /** Lines that start a list item (`*`, `-`, a bullet, or `1.`). */
  bullets: number;
  /** Markdown heading lines (`#`). */
  headings: number;
  /** Markdown table lines (`| a | b |`). */
  tableRows: number;
  /** `**bold**` spans. */
  boldSpans: number;
  /** Words before the first sentence or line ends: how soon the answer itself starts. */
  firstSentenceWords: number;
}

const wordCount = (s: string): number => (s.trim().match(/\S+/g) ?? []).length;

export function answerShape(text: string): AnswerShape {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  // the first sentence ends at a line break, or at ". " (or ! ?) before a capital letter, a digit-led money sign, a bracket or markup
  const first = text.trim().split(/\n|(?<=[.!?])\s+(?=[A-Z$(*`])/)[0] ?? "";
  return {
    words: wordCount(text),
    lines: lines.length,
    bullets: lines.filter((l) => /^\s*(?:[*\-•]|\d+\.)\s/.test(l)).length,
    headings: lines.filter((l) => /^\s*#{1,6}\s/.test(l)).length,
    tableRows: lines.filter((l) => /^\s*\|.*\|\s*$/.test(l)).length,
    boldSpans: (text.match(/\*\*[^*\n]+\*\*/g) ?? []).length,
    firstSentenceWords: wordCount(first),
  };
}

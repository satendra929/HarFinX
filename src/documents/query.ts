// Cleaning a search query before it reaches the index. Questions arrive with instructions that say nothing about where
// the answer is printed ("If X is not a useful metric, state that and explain why.", "Answer in USD millions.") and
// with dates that appear on every page ("FY2022", "Q2'2023"). Those words pull unrelated pages up. Generic rules only:
// no list of finance terms, nothing tuned to particular questions.

// A sentence that starts like an instruction or a condition is about how to answer, not about what to find.
const INSTRUCTION = /^(?:if|answer|respond|please|assume|state|explain|provide|round|express|note|consider|give|show|use|then)\b/i;

// Fiscal and calendar markers: FY22, FY2022, CY2021, Q2'2023, Q22023, 2Q23, and bare years.
const MARKERS = [/\b(?:FY|CY)\s?'?\d{2,4}\b/gi, /\bQ[1-4]\s?'?\d{2,4}\b/gi, /\b[1-4]Q\s?'?\d{2,4}\b/gi, /\b(?:19|20)\d{2}\b/g];

/** The query without instruction sentences and date markers. Falls back to the original if nothing useful is left. */
export function cleanQuery(query: string): string {
  const text = query.replace(/\s+/g, " ").trim();
  // the first sentence is the question itself and always stays; later ones stay unless they read as instructions
  const sentences = text.split(/(?<=[.?!])\s+/);
  let cleaned = sentences.filter((s, i) => i === 0 || !INSTRUCTION.test(s)).join(" ");
  for (const marker of MARKERS) cleaned = cleaned.replace(marker, " ");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return /[A-Za-z]{3}/.test(cleaned) ? cleaned : text;
}

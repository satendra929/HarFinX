// When is a tool call "the same call" as an earlier one in the same question? One key per call; two calls with the same
// key would return the same result, so the second is not run (src/guard.ts). Pure: no I/O.
//   search     the same file, section and words, whatever the capitals, word order or repeated words
//   read_page  the same file, page, part and `find` words
//   others     the same tool with the same arguments (a path spelled two ways is one path)
// `calculate` has no key: it is cheap, its result depends only on its inputs, and a repeat does no harm.
import { fileKey } from "./sources.ts";
import { tokenize } from "./documents/search.ts";
import { cleanQuery } from "./documents/query.ts";

const squash = (v: unknown, max: number): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
// A passage is scored on the set of its words, so their order does not matter there.
const wordSet = (s: string): string => [...new Set(tokenize(s))].sort().join(" ");
// A search also scores words that stand side by side, in the order typed, so for a query the order (and a repeated word) matters.
// Capitals, spacing, stop words, stemming and years are dropped by the tokenizer and the cleaner, as in the tool.
const wordSeq = (s: string): string => tokenize(s).join(" ");

export function callKey(name: string, args: unknown): string | undefined {
  if (name === "calculate" || !args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const a = args as Record<string, unknown>;
  if (name === "search") {
    // The same limits and cleaning as the search tool applies, so two queries it ranks alike get one key.
    return ["search", fileKey(String(a.path ?? "")), squash(a.section, 60).toLowerCase(), wordSeq(cleanQuery(squash(a.query, 200)))].join("|");
  }
  if (name === "read_page") {
    return ["read_page", fileKey(String(a.path ?? "")), String(Number(a.page)), String(Number(a.part ?? 1)), wordSet(squash(a.find, 200))].join("|");
  }
  const rest = Object.keys(a)
    .sort()
    .map((k) => [k, k === "path" ? fileKey(String(a[k] ?? "")) : a[k]]);
  try {
    return `${name}|${JSON.stringify(rest)}`;
  } catch {
    return undefined;
  }
}

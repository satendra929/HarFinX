// The read check: an answer built on fewer pages than READ_MIN_PAGES gets ONE fixed message before it is shown, naming the next
// pages the search listed (src/engine.ts, settleAnswer). This file holds the two pure parts: which answers are exempt and the text.
// It matches no wording: the exemption looks at the answer's size and layout only (src/shape.ts).
import type { AnswerShape } from "./shape.ts";

/** A reply this short with no list lines is a lookup, not a topic answer: it does not need more pages. */
export const SHORT_ANSWER_WORDS = 40;

export function isShortAnswer(shape: AnswerShape): boolean {
  return shape.words <= SHORT_ANSWER_WORDS && shape.bullets === 0 && shape.headings === 0 && shape.tableRows === 0;
}

const list = (pages: readonly number[]): string => (pages.length === 1 ? `page ${pages[0]}` : `pages ${pages.slice(0, -1).join(", ")} and ${pages[pages.length - 1]}`);

/** For an answer given with no search in the question: search first, then open the top pages (`total` pages looked at in all). */
export function searchMessage(file: string, looked: number, total: number): string {
  return (
    `Not shown to the user yet: you answered without searching ${file}, and you looked at ${looked === 1 ? "1 page" : `${looked} pages`} for this question. ` +
    `Before you answer, call search on ${file} with words printed in the filing that match the question, open the top pages it lists with read_page until you have looked at ${total} pages in all, then write the whole answer again using what they add. ` +
    "Keep the answer as short as the question needs: the main points only, and no figure you do not need."
  );
}

/** The fixed message. `looked` pages were opened so far; `missing` are the next listed pages, in rank order. */
export function readMessage(file: string, looked: number, missing: readonly number[]): string {
  return (
    `Not shown to the user yet: you looked at ${looked === 1 ? "1 page" : `${looked} pages`} for this question, and a search ranked more pages high. ` +
    `Before you answer, open ${list(missing)} of ${file} with read_page, then write the whole answer again using what they add. ` +
    "Keep the answer as short as the question needs: the main points only, and no figure you do not need."
  );
}

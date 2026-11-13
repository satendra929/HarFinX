import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanQuery } from "../src/documents/query.ts";

test("instruction sentences after the question are dropped; the question itself always stays", () => {
  assert.equal(cleanQuery("Does AMD have a healthy liquidity profile based on its quick ratio? If the quick ratio is not relevant to measure liquidity, please state that and explain why."), "Does AMD have a healthy liquidity profile based on its quick ratio?");
  assert.equal(cleanQuery("What is the gross margin? Answer in USD millions."), "What is the gross margin?");
  assert.equal(cleanQuery("Respond to the question by assuming the perspective of an analyst. What is net income?"), "Respond to the question by assuming the perspective of an analyst. What is net income?"); // the first sentence is kept as is
  assert.equal(cleanQuery("What is net income? Respond using only the income statement. Round to two decimals."), "What is net income?");
});

test("a later sentence that is not an instruction stays (a definition holds useful words)", () => {
  assert.equal(cleanQuery("What is net working capital? Define net working capital as total current assets less total current liabilities."), "What is net working capital? Define net working capital as total current assets less total current liabilities.");
});

test("fiscal and calendar markers are removed, other numbers are not", () => {
  assert.equal(cleanQuery("What was revenue in FY2022 versus FY21 and CY2020?"), "What was revenue in versus and ?");
  assert.equal(cleanQuery("Q2'2023 and Q22023 and 2Q23 sales in 2019"), "and and sales in");
  assert.equal(cleanQuery("Which segment had more than 20% of revenue in 2022?"), "Which segment had more than 20% of revenue in ?");
});

test("whitespace is tidied; a query that would be empty comes back unchanged", () => {
  assert.equal(cleanQuery("  total   current\n assets  "), "total current assets");
  assert.equal(cleanQuery("FY2022"), "FY2022");
  assert.equal(cleanQuery("2022"), "2022");
  assert.equal(cleanQuery(""), "");
});

test("the question word 'If' in the first sentence is not treated as an instruction", () => {
  assert.equal(cleanQuery("If sales fell, why did margin change?"), "If sales fell, why did margin change?");
});

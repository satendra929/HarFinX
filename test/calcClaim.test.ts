import { test } from "node:test";
import assert from "node:assert/strict";
import { calculationClaim, calculationClaimLine } from "../src/check.ts";

test("claims of having used the calculate tool are found, in the ways a model words them", () => {
  const claims = [
    "(Calculations performed using the `calculate` tool with the values from page 39 of the filing.)",
    "Using the calculate tool, the margin is 6.75%.",
    "I used the calculator to get 6.94%.",
    "The ratio was computed with the calculate tool: 3.41.",
    "Result from the calculator: 41.68%.",
    "This comes via the `calculate` function.",
    "Per the calculate tool, working capital is 2,278.",
    "The `calculate` tool returned 12.5%.",
    "The calculator tool gave 7.9%.",
    "Verified through the calculation tool.",
  ];
  for (const c of claims) assert.ok(calculationClaim(c), c);
});

test("more ways of wording it: no 'the', bold or backticks, a call or output, a verb of calling, a footer", () => {
  const claims = [
    "I computed this using calculate.",
    "Using `calculate`, the ratio is 3.4.",
    "Computed by calculate: 12.4%.",
    "I used calculate to find the ratio.",
    "Margin: 6.75% (via calculate)",
    "As returned by calculate, the margin is 6.75%.",
    "My calculate call returned 6.75%.",
    "My `calculate` call gave 6.75%.",
    "Calculator output: 41.68%.",
    "The calculator output shows 41.68%.",
    "I called `calculate` with the two inputs.",
    "Ran calculate on these values: result 4.2.",
    "Using the **calculate** tool, I get 5%.",
    "Tool used: calculate.",
    "Tool: `calculate`",
  ];
  for (const c of claims) assert.ok(calculationClaim(c), c);
});

test("a negation AFTER the mention is a negation too, and so are the contracted forms before it", () => {
  const notClaims = [
    "The calculate tool was not used.",
    "The calculate tool wasn't used for this answer.",
    "The calculate tool was never invoked.",
    "The calculate tool was unavailable.",
    "The `calculate` tool is not available here.",
    "I haven't used the calculate tool here.",
    "Neither the calculate tool nor a spreadsheet was used.",
    "It hasn't called calculate yet.",
    "Using the calculate tool was not possible, so these are estimates.",
  ];
  for (const c of notClaims) assert.equal(calculationClaim(c), undefined, c);
});

test("a definition, a generic mention, a negation or code are not claims", () => {
  const notClaims = [
    "Working capital is calculated as current assets minus current liabilities.",
    "The quick ratio is calculated by dividing quick assets by current liabilities.",
    "You can use a calculator to check this.",
    "Calculations are shown below: 5,818 - 5,923.",
    "I did not use the calculate tool for this.",
    "I did not need the calculate tool here.",
    "Without the calculate tool I cannot give an exact figure.",
    "I can't use the calculate tool on text this short.",
    "No calculation was run; the calculate tool was not used.",
    "```\nUsing the calculate tool\n```",
    "The recalculated value is 5.",
    "To calculate this, you would divide net income by sales.",
    "The calculated margin is 6.75%.",
    "Calculation: 5,818 / 5,923.",
    "We calculate the ratio as quick assets over current liabilities.",
    "Recalculate if the inputs change.",
    "Calculators and spreadsheets are common tools.",
    "",
  ];
  for (const c of notClaims) assert.equal(calculationClaim(c), undefined, c);
});

test("a negation far from the claim does not cancel it (only the words just before count)", () => {
  assert.ok(calculationClaim("I did not guess. The margin was computed using the calculate tool."));
  assert.equal(calculationClaim("I did not use the calculate tool."), undefined);
  assert.ok(calculationClaim("No figures are missing.\nUsing the calculate tool, the margin is 6.75%."));
});

test("the claim is reported with its own wording, whitespace collapsed", () => {
  assert.equal(calculationClaim("Computed  using\nthe  calculate tool."), "using the calculate");
  assert.equal(calculationClaim("See the calculate tool output."), "calculate tool");
});

test("calculationClaimLine: only when the claim is made and no calculation ran in the question", () => {
  const said = "Working capital is $2,278 (calculated using the calculate tool).";
  const line = calculationClaimLine(said, 0)!;
  assert.match(line.text, /^\[check\] The answer says "using the calculate", but no calculation ran for this question/);
  assert.match(line.text, /model's own arithmetic/);
  assert.equal(line.phrase, "using the calculate");
  assert.equal(calculationClaimLine(said, 1), undefined); // it did run
  assert.equal(calculationClaimLine(said, 5), undefined);
  assert.equal(calculationClaimLine("Working capital is $2,278.", 0), undefined); // no claim, no line
  assert.equal(calculationClaimLine("", 0), undefined);
});

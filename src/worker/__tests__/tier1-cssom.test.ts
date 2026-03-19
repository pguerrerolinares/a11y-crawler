import { test, expect } from "bun:test";
import { evaluateHoverContrast } from "../tier1-cssom";

test("sufficient hover contrast returns pass", () => {
  const result = evaluateHoverContrast(
    { backgroundColor: "rgb(255,255,255)" },     // default
    { backgroundColor: "rgb(0,0,0)" },             // hover
    "rgb(255,255,255)",                             // parent bg
  );
  expect(result).toBe("pass");
});

test("insufficient hover contrast returns fail", () => {
  const result = evaluateHoverContrast(
    { backgroundColor: "rgb(200,200,200)" },
    { backgroundColor: "rgb(210,210,210)" },
    "rgb(255,255,255)",
  );
  expect(result).toBe("fail");
});

test("no hover rules returns ambiguous", () => {
  const result = evaluateHoverContrast(
    { backgroundColor: "rgb(255,255,255)" },
    null, // CSSOM couldn't resolve
    "rgb(255,255,255)",
  );
  expect(result).toBe("ambiguous");
});

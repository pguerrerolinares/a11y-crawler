import { test, expect } from "bun:test";
import { installResourceBlocker } from "../resource-blocker";

test("installResourceBlocker is exported as a function", () => {
  expect(typeof installResourceBlocker).toBe("function");
});

import { test, expect } from "bun:test";
import { runInteractiveTests } from "../interactive.ts";

test("runInteractiveTests is exported and is a function", () => {
  expect(typeof runInteractiveTests).toBe("function");
});

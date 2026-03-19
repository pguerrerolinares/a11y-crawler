import { test, expect } from "bun:test";
import { adaptiveWait } from "../adaptive-wait";

test("adaptiveWait is a function", () => {
  expect(typeof adaptiveWait).toBe("function");
});

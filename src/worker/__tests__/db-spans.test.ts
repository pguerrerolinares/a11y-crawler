import { describe, test, expect } from "bun:test";
import { persistSpans, insertPageV4, insertIssuesV4 } from "../db";

describe("persistSpans", () => {
  test("is exported as an async function", () => {
    expect(typeof persistSpans).toBe("function");
  });
});

describe("insertPageV4", () => {
  test("is exported as an async function", () => {
    expect(typeof insertPageV4).toBe("function");
  });
});

describe("insertIssuesV4", () => {
  test("is exported as an async function", () => {
    expect(typeof insertIssuesV4).toBe("function");
  });
});

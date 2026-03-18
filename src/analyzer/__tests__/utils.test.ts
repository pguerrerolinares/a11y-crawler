import { test, expect } from "bun:test";
import { buildCssSelector } from "../utils";

test("buildCssSelector prefers id", () => {
  expect(buildCssSelector("div", "my-id", "foo bar")).toBe("#my-id");
});

test("buildCssSelector uses tag.class when no id", () => {
  expect(buildCssSelector("div", "", "foo bar baz")).toBe("div.foo.bar.baz");
});

test("buildCssSelector limits to 3 classes", () => {
  expect(buildCssSelector("span", "", "a b c d e")).toBe("span.a.b.c");
});

test("buildCssSelector falls back to tag", () => {
  expect(buildCssSelector("button", "", "")).toBe("button");
});

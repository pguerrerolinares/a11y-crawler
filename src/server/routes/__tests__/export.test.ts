import { test, expect, describe } from "bun:test";
import { csvEscape } from "../export.ts";

describe("csvEscape", () => {
  test("plain string passes through unchanged", () => {
    expect(csvEscape("hello")).toBe("hello");
  });

  test("string with comma is quoted", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
  });

  test("string with double quotes escapes them", () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });

  test("string with newline is quoted", () => {
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });

  test("empty string passes through", () => {
    expect(csvEscape("")).toBe("");
  });

  test("null/undefined becomes empty string", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
  });
});

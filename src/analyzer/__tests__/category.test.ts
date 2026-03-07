import { describe, test, expect } from "bun:test";
import { getViolationCategory } from "../category.ts";

describe("getViolationCategory", () => {
  test("maps color-contrast to visual", () => {
    expect(getViolationCategory("color-contrast")).toBe("visual");
  });

  test("maps image-alt to media", () => {
    expect(getViolationCategory("image-alt")).toBe("media");
  });

  test("maps button-name to interactive", () => {
    expect(getViolationCategory("button-name")).toBe("interactive");
  });

  test("maps heading-order to structural", () => {
    expect(getViolationCategory("heading-order")).toBe("structural");
  });

  test("maps html-has-lang to semantic", () => {
    expect(getViolationCategory("html-has-lang")).toBe("semantic");
  });

  test("defaults to structural for unknown rules", () => {
    expect(getViolationCategory("unknown-rule")).toBe("structural");
  });
});

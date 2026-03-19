import { test, expect } from "bun:test";
import { getAutoFillValue } from "../form-autofill";

test("getAutoFillValue returns correct value per input type", () => {
  expect(getAutoFillValue("email", "input")).toBe("test@example.com");
  expect(getAutoFillValue("tel", "input")).toBe("+34600000000");
  expect(getAutoFillValue("text", "input")).toBe("Test accessibility audit");
  expect(getAutoFillValue(null, "textarea")).toBe("Test accessibility audit");
});

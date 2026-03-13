import { test, expect } from "bun:test";
import {
  testReflow,
  testTextSpacing,
  testResizeText,
  testMultimedia,
  testTimedEvents,
} from "../wcag-tests";

test("testReflow is exported as a function", () => {
  expect(typeof testReflow).toBe("function");
});

test("testTextSpacing is exported as a function", () => {
  expect(typeof testTextSpacing).toBe("function");
});

test("testResizeText is exported as a function", () => {
  expect(typeof testResizeText).toBe("function");
});

test("testMultimedia is exported as a function", () => {
  expect(typeof testMultimedia).toBe("function");
});

test("testTimedEvents is exported as a function", () => {
  expect(typeof testTimedEvents).toBe("function");
});

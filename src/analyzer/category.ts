import type { ViolationCategory } from "../types/issue.ts";

const CATEGORY_MAP: Record<string, ViolationCategory> = {
  // Structural
  "landmark-one-main": "structural",
  "region": "structural",
  "heading-order": "structural",
  "list": "structural",
  "listitem": "structural",
  "bypass": "structural",
  "page-has-heading-one": "structural",

  // Semantic
  "document-title": "semantic",
  "html-has-lang": "semantic",
  "html-lang-valid": "semantic",
  "valid-lang": "semantic",
  "link-in-text-block": "semantic",

  // Interactive
  "label": "interactive",
  "button-name": "interactive",
  "link-name": "interactive",
  "input-image-alt": "interactive",
  "select-name": "interactive",
  "tabindex": "interactive",
  "focus-order-semantics": "interactive",
  "aria-required-attr": "interactive",
  "aria-valid-attr": "interactive",
  "aria-valid-attr-value": "interactive",
  "aria-roles": "interactive",

  // Visual
  "color-contrast": "visual",
  "meta-viewport": "visual",
  "target-size": "visual",

  // Media
  "image-alt": "media",
  "image-redundant-alt": "media",
  "video-caption": "media",
  "audio-caption": "media",
  "object-alt": "media",
  "svg-img-alt": "media",
};

export function getViolationCategory(ruleId: string): ViolationCategory {
  return CATEGORY_MAP[ruleId] || "structural";
}

export type ReportCategory =
  | "color-contrast"
  | "keyboard-navigation"
  | "forms-labels"
  | "aria-semantics"
  | "images-media"
  | "structure-headings"
  | "links-buttons"
  | "timing-motion"
  | "language-text"
  | "legal-compliance";

export interface CriterionMeta {
  name: string;
  level: "A" | "AA" | "AAA";
}

export interface CategoryMeta {
  name: string;
  description: string;
}

// Maps axe-core rules and custom test rules to report categories
export const RULE_CATEGORY: Record<string, ReportCategory> = {
  // color-contrast
  "color-contrast": "color-contrast",
  "color-contrast-enhanced": "color-contrast",
  "wcag-color-use": "color-contrast",

  // keyboard-navigation
  "keyboard": "keyboard-navigation",
  "focus-order": "keyboard-navigation",
  "focus-visible": "keyboard-navigation",
  "no-keyboard-trap": "keyboard-navigation",
  "bypass-blocks": "keyboard-navigation",
  "tabindex": "keyboard-navigation",
  "wcag-hover-focus": "keyboard-navigation",

  // forms-labels
  "label": "forms-labels",
  "label-title-only": "forms-labels",
  "label-content-name-mismatch": "forms-labels",
  "select-name": "forms-labels",
  "input-button-name": "forms-labels",
  "autocomplete-valid": "forms-labels",
  "wcag-sensory-instructions": "forms-labels",

  // aria-semantics
  "aria-required-attr": "aria-semantics",
  "aria-required-children": "aria-semantics",
  "aria-required-parent": "aria-semantics",
  "aria-roles": "aria-semantics",
  "aria-valid-attr": "aria-semantics",
  "aria-valid-attr-value": "aria-semantics",
  "aria-allowed-attr": "aria-semantics",
  "aria-prohibited-attr": "aria-semantics",
  "aria-hidden-body": "aria-semantics",
  "aria-hidden-focus": "aria-semantics",
  "aria-input-field-name": "aria-semantics",
  "aria-meter-name": "aria-semantics",
  "aria-progressbar-name": "aria-semantics",
  "aria-toggle-field-name": "aria-semantics",
  "aria-tooltip-name": "aria-semantics",
  "aria-treeitem-name": "aria-semantics",
  "aria-command-name": "aria-semantics",
  "aria-dialog-name": "aria-semantics",
  "wcag-aria-states": "aria-semantics",
  "wcag-status-messages": "aria-semantics",

  // images-media
  "image-alt": "images-media",
  "input-image-alt": "images-media",
  "area-alt": "images-media",
  "role-img-alt": "images-media",
  "svg-img-alt": "images-media",
  "video-caption": "images-media",
  "audio-caption": "images-media",
  "object-alt": "images-media",
  "image-redundant-alt": "images-media",

  // structure-headings
  "heading-order": "structure-headings",
  "empty-heading": "structure-headings",
  "region": "structure-headings",
  "landmark-one-main": "structure-headings",
  "landmark-no-duplicate-banner": "structure-headings",
  "landmark-no-duplicate-contentinfo": "structure-headings",
  "landmark-no-duplicate-main": "structure-headings",
  "landmark-banner-is-top-level": "structure-headings",
  "landmark-complementary-is-top-level": "structure-headings",
  "landmark-contentinfo-is-top-level": "structure-headings",
  "landmark-main-is-top-level": "structure-headings",
  "document-title": "structure-headings",
  "html-has-lang": "structure-headings",
  "html-lang-valid": "structure-headings",
  "frame-title": "structure-headings",
  "frame-title-unique": "structure-headings",
  "wcag-meaningful-sequence": "structure-headings",
  "wcag-semantic-structure": "structure-headings",

  // links-buttons
  "link-name": "links-buttons",
  "button-name": "links-buttons",
  "duplicate-id-active": "links-buttons",
  "duplicate-id": "links-buttons",
  "duplicate-id-aria": "links-buttons",
  "link-in-text-block": "links-buttons",
  "identical-links-same-purpose": "links-buttons",

  // timing-motion
  "meta-refresh": "timing-motion",
  "animation-duration-too-long": "timing-motion",
  "meta-refresh-no-exceptions": "timing-motion",

  // language-text
  "lang-valid": "language-text",
  "html-xml-lang-mismatch": "language-text",
  "valid-lang": "language-text",

  // legal-compliance
  "accessibility-declaration-missing": "legal-compliance",

  // visual-presentation rules (mapped to color-contrast as closest category)
  "resize-text": "color-contrast",
  "wcag-reflow": "color-contrast",
  "wcag-text-spacing": "color-contrast",

  // interactive-widgets rules (mapped to keyboard-navigation)
  "target-size": "keyboard-navigation",
  "wcag-target-size": "keyboard-navigation",
  "pointer-gestures": "keyboard-navigation",

  // table / data rules (mapped to structure-headings)
  "td-headers-attr": "structure-headings",
  "th-has-data-cells": "structure-headings",
  "table-fake-caption": "structure-headings",
  "scope-attr-valid": "structure-headings",

  // error handling (mapped to forms-labels)
  "wcag-error-identification": "forms-labels",
  "wcag-legal-checks": "legal-compliance",

  // state change contrast (mapped to color-contrast)
  "wcag-state-change-contrast": "color-contrast",
};

// WCAG 2.2 criteria with name and conformance level
export const CRITERION_META: Record<string, CriterionMeta> = {
  // Perceivable — Level A
  "1.1.1": { name: "Non-text Content", level: "A" },
  "1.2.1": { name: "Audio-only and Video-only (Prerecorded)", level: "A" },
  "1.2.2": { name: "Captions (Prerecorded)", level: "A" },
  "1.2.3": { name: "Audio Description or Media Alternative (Prerecorded)", level: "A" },
  "1.3.1": { name: "Info and Relationships", level: "A" },
  "1.3.2": { name: "Meaningful Sequence", level: "A" },
  "1.3.3": { name: "Sensory Characteristics", level: "A" },
  "1.4.1": { name: "Use of Color", level: "A" },
  "1.4.2": { name: "Audio Control", level: "A" },

  // Perceivable — Level AA
  "1.2.4": { name: "Captions (Live)", level: "AA" },
  "1.2.5": { name: "Audio Description (Prerecorded)", level: "AA" },
  "1.3.4": { name: "Orientation", level: "AA" },
  "1.3.5": { name: "Identify Input Purpose", level: "AA" },
  "1.4.3": { name: "Contrast (Minimum)", level: "AA" },
  "1.4.4": { name: "Resize Text", level: "AA" },
  "1.4.5": { name: "Images of Text", level: "AA" },
  "1.4.10": { name: "Reflow", level: "AA" },
  "1.4.11": { name: "Non-text Contrast", level: "AA" },
  "1.4.12": { name: "Text Spacing", level: "AA" },
  "1.4.13": { name: "Content on Hover or Focus", level: "AA" },

  // Perceivable — Level AAA
  "1.2.6": { name: "Sign Language (Prerecorded)", level: "AAA" },
  "1.2.7": { name: "Extended Audio Description (Prerecorded)", level: "AAA" },
  "1.2.8": { name: "Media Alternative (Prerecorded)", level: "AAA" },
  "1.2.9": { name: "Audio-only (Live)", level: "AAA" },
  "1.3.6": { name: "Identify Purpose", level: "AAA" },
  "1.4.6": { name: "Contrast (Enhanced)", level: "AAA" },
  "1.4.7": { name: "Low or No Background Audio", level: "AAA" },
  "1.4.8": { name: "Visual Presentation", level: "AAA" },
  "1.4.9": { name: "Images of Text (No Exception)", level: "AAA" },

  // Operable — Level A
  "2.1.1": { name: "Keyboard", level: "A" },
  "2.1.2": { name: "No Keyboard Trap", level: "A" },
  "2.2.1": { name: "Timing Adjustable", level: "A" },
  "2.2.2": { name: "Pause, Stop, Hide", level: "A" },
  "2.3.1": { name: "Three Flashes or Below Threshold", level: "A" },
  "2.4.1": { name: "Bypass Blocks", level: "A" },
  "2.4.2": { name: "Page Titled", level: "A" },
  "2.4.3": { name: "Focus Order", level: "A" },
  "2.4.4": { name: "Link Purpose (In Context)", level: "A" },
  "2.5.1": { name: "Pointer Gestures", level: "A" },
  "2.5.2": { name: "Pointer Cancellation", level: "A" },
  "2.5.3": { name: "Label in Name", level: "A" },
  "2.5.4": { name: "Motion Actuation", level: "A" },

  // Operable — Level AA
  "2.4.5": { name: "Multiple Ways", level: "AA" },
  "2.4.6": { name: "Headings and Labels", level: "AA" },
  "2.4.7": { name: "Focus Visible", level: "AA" },
  "2.4.11": { name: "Focus Not Obscured (Minimum)", level: "AA" },
  "2.4.12": { name: "Focus Not Obscured (Enhanced)", level: "AAA" },
  "2.5.8": { name: "Target Size (Minimum)", level: "AA" },

  // Operable — Level AAA
  "2.1.3": { name: "Keyboard (No Exception)", level: "AAA" },
  "2.2.3": { name: "No Timing", level: "AAA" },
  "2.2.4": { name: "Interruptions", level: "AAA" },
  "2.2.5": { name: "Re-authenticating", level: "AAA" },
  "2.2.6": { name: "Timeouts", level: "AAA" },
  "2.3.2": { name: "Three Flashes", level: "AAA" },
  "2.3.3": { name: "Animation from Interactions", level: "AAA" },
  "2.4.8": { name: "Location", level: "AAA" },
  "2.4.9": { name: "Link Purpose (Link Only)", level: "AAA" },
  "2.4.10": { name: "Section Headings", level: "AAA" },
  "2.4.13": { name: "Focus Appearance", level: "AAA" },
  "2.5.5": { name: "Target Size (Enhanced)", level: "AAA" },
  "2.5.6": { name: "Concurrent Input Mechanisms", level: "AAA" },
  "2.5.7": { name: "Dragging Movements", level: "AAA" },

  // Understandable — Level A
  "3.1.1": { name: "Language of Page", level: "A" },
  "3.2.1": { name: "On Focus", level: "A" },
  "3.2.2": { name: "On Input", level: "A" },
  "3.3.1": { name: "Error Identification", level: "A" },
  "3.3.2": { name: "Labels or Instructions", level: "A" },

  // Understandable — Level AA
  "3.1.2": { name: "Language of Parts", level: "AA" },
  "3.2.3": { name: "Consistent Navigation", level: "AA" },
  "3.2.4": { name: "Consistent Identification", level: "AA" },
  "3.2.6": { name: "Consistent Help", level: "A" },
  "3.3.3": { name: "Error Suggestion", level: "AA" },
  "3.3.4": { name: "Error Prevention (Legal, Financial, Data)", level: "AA" },
  "3.3.7": { name: "Redundant Entry", level: "A" },
  "3.3.8": { name: "Accessible Authentication (Minimum)", level: "AA" },

  // Understandable — Level AAA
  "3.1.3": { name: "Unusual Words", level: "AAA" },
  "3.1.4": { name: "Abbreviations", level: "AAA" },
  "3.1.5": { name: "Reading Level", level: "AAA" },
  "3.1.6": { name: "Pronunciation", level: "AAA" },
  "3.2.5": { name: "Change on Request", level: "AAA" },
  "3.3.5": { name: "Help", level: "AAA" },
  "3.3.6": { name: "Error Prevention (All)", level: "AAA" },
  "3.3.9": { name: "Accessible Authentication (Enhanced)", level: "AAA" },

  // Robust — Level A
  "4.1.1": { name: "Parsing", level: "A" },
  "4.1.2": { name: "Name, Role, Value", level: "A" },

  // Robust — Level AA
  "4.1.3": { name: "Status Messages", level: "AA" },
};

// 10 report categories with human-readable names and descriptions
export const CATEGORY_META: Record<ReportCategory, CategoryMeta> = {
  "color-contrast": {
    name: "Color & Contrast",
    description: "Issues related to color contrast ratios and use of color to convey information.",
  },
  "keyboard-navigation": {
    name: "Keyboard Navigation",
    description: "Issues affecting users who navigate using keyboard, including focus order and traps.",
  },
  "forms-labels": {
    name: "Forms & Labels",
    description: "Issues with form controls, labels, instructions, and input identification.",
  },
  "aria-semantics": {
    name: "ARIA & Semantics",
    description: "Issues with ARIA attributes, roles, and semantic markup for assistive technologies.",
  },
  "images-media": {
    name: "Images & Media",
    description: "Issues with alternative text for images and captions for audio/video content.",
  },
  "structure-headings": {
    name: "Structure & Headings",
    description: "Issues with page structure, heading hierarchy, landmarks, and document organization.",
  },
  "links-buttons": {
    name: "Links & Buttons",
    description: "Issues with link and button names, purposes, and identifier uniqueness.",
  },
  "timing-motion": {
    name: "Timing & Motion",
    description: "Issues with time limits, moving content, and animation that may cause distraction.",
  },
  "language-text": {
    name: "Language & Text",
    description: "Issues with language identification for page content and text alternatives.",
  },
  "legal-compliance": {
    name: "Legal Compliance",
    description: "Issues related to legal accessibility requirements such as accessibility declarations.",
  },
};

export function getCriterionMeta(criterion: string): CriterionMeta | null {
  return CRITERION_META[criterion] ?? null;
}

export function getReportCategory(rule: string): ReportCategory | "uncategorized" {
  return RULE_CATEGORY[rule] ?? "uncategorized";
}

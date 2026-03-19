// src/types/manifest.ts
export interface ElementManifest {
  selector: string;
  tag: string;
  role: string | null;
  accessibleName: string;
  boundingBox: { x: number; y: number; width: number; height: number };
  hasHoverCss: boolean;
  hasAriaExpanded: boolean;
  hasAriaPressed: boolean;
  hasUnderline: boolean;
  isFormControl: boolean;
  defaultStyles: {
    borderColor: string;
    outlineColor: string;
    backgroundColor: string;
    boxShadow: string;
    textDecorationLine: string;
    color: string;
  };
  parentBg: string;
  styleFingerprint: string;
}

export interface StyleGroup {
  fingerprint: string;
  representative: ElementManifest;
  members: ElementManifest[];
}

export interface InteractionResult {
  hoverStyles?: Record<string, string>;
  hoverPopup?: PopupInfo | null;
  popupPersistent?: boolean;
  popupHoverable?: boolean;
  popupDismissible?: boolean;
  focusStyles?: Record<string, string>;
  focusIndicatorVisible?: boolean;
  focusPopup?: PopupInfo | null;
  ariaStateChanged?: boolean;
  keyboardResponded?: boolean;
}

export interface PopupInfo {
  selector: string;
  type: "dom-mutation" | "css-transition";
  boundingBox: { x: number; y: number; width: number; height: number };
}

export type TierResult = "pass" | "fail" | "ambiguous" | "no-change";

export interface ProbeTiming {
  auditId: string;
  templateId: string;
  url: string;
  tier0: { durationMs: number; elementsDiscovered: number; styleGroups: number; representativeElements: number };
  tier1: { durationMs: number; issuesFound: number; elementsPromotedToTier2: number; skippedByFingerprint: number };
  tier2: { durationMs: number; interactions: { hovers: number; focuses: number; clicks: number; keyboardTests: number }; issuesFound: number; elementsPromotedToTier3: number; avgWaitMs: number };
  tier3: { durationMs: number; llmCalls: number; llmInputTokens: number; llmOutputTokens: number; imagesSent: number; avgImageSizeBytes: number; issuesConfirmed: number; issuesDiscarded: number; cacheHits: number; earlyTerminations: number };
}

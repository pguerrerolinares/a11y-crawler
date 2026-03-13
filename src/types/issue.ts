export type ImpactLevel = "critical" | "serious" | "moderate" | "minor";

export type CheckSource = "axe" | "llm" | "interactive" | "scan-light" | "wcag-custom";

export type ViolationCategory =
  | "structural"
  | "interactive"
  | "visual"
  | "media"
  | "semantic";

export interface Issue {
  id: string;
  url: string;
  rule: string;
  impact: ImpactLevel;
  description: string;
  help: string;
  helpUrl: string;
  wcagTags: string[];
  selector: string;
  html: string;
  surroundingHtml: string;
  xpath: string;
  viewportWidth: number;
  pageTitle: string;
  checkSource: CheckSource;
  suggestedFix: string | null;
  fixConfidence: "unvalidated, requires human review" | null;
  /** LLM-reported confidence for the suggestedFix ("high"|"medium"|"low"), null if not enriched */
  llmConfidence: "high" | "medium" | "low" | null;
  /** WCAG criterion cited by LLM for the fix (e.g. "1.4.3"), null if not enriched */
  wcagCriterion: string | null;
  violationCategory: ViolationCategory;
}

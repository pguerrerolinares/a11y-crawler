export type ImpactLevel = "critical" | "serious" | "moderate" | "minor";

export type CheckSource = "axe" | "llm";

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
  violationCategory: ViolationCategory;
}

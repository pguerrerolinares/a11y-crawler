import type { ViolationCategory } from "../types/issue.ts";

const COMMON_RULES = `Rules:
- Provide the EXACT corrected HTML (not descriptions of what to change)
- Preserve all existing attributes and content
- Only modify what is necessary to fix the violation
- If unsure, say "Manual review required: [reason]"

Respond with a JSON array:
[{ "issueId": "...", "suggestedFix": "corrected HTML or explanation" }]`;

const PROMPTS: Record<ViolationCategory, string> = {
  structural: `You are a WCAG 2.2 accessibility remediation expert specializing in document structure (landmarks, headings, lists, regions).

${COMMON_RULES}`,

  interactive: `You are a WCAG 2.2 accessibility remediation expert specializing in interactive elements (forms, buttons, links, keyboard navigation, ARIA attributes).

${COMMON_RULES}`,

  visual: `You are a WCAG 2.2 accessibility remediation expert specializing in visual presentation (color contrast, text spacing, reflow, resize).

NOTE: Without a screenshot, base suggestions on the HTML/CSS provided. If the fix requires visual verification, say "Requires visual review: [reason]".

${COMMON_RULES}`,

  media: `You are a WCAG 2.2 accessibility remediation expert specializing in non-text content (images, video, audio, objects).

${COMMON_RULES}`,

  semantic: `You are a WCAG 2.2 accessibility remediation expert specializing in semantics (language attributes, link purpose, page titles).

${COMMON_RULES}`,
};

export function getPromptForCategory(category: ViolationCategory): string {
  return PROMPTS[category];
}

export interface FixResult {
  issueId: string;
  suggestedFix: string;
}

export function parseFixes(response: string): FixResult[] {
  try {
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((f: any) => f.issueId && f.suggestedFix)
      .map((f: any) => ({
        issueId: String(f.issueId),
        suggestedFix: String(f.suggestedFix),
      }));
  } catch {
    return [];
  }
}

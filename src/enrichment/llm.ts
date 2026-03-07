import type { Issue, ViolationCategory } from "../types/issue.ts";
import type { LLMClient } from "../llm/client.ts";
import { getPromptForCategory, parseFixes } from "./prompts.ts";

/**
 * Enrich issues with LLM-generated fix suggestions.
 * Groups by violation category, sends one prompt per category batch.
 */
export async function enrichIssues(
  issues: Issue[],
  llmClient: LLMClient,
): Promise<Issue[]> {
  if (issues.length === 0) return issues;

  // Group by category
  const byCategory = new Map<ViolationCategory, Issue[]>();
  for (const issue of issues) {
    const existing = byCategory.get(issue.violationCategory) || [];
    existing.push(issue);
    byCategory.set(issue.violationCategory, existing);
  }

  const fixMap = new Map<string, string>();

  for (const [category, categoryIssues] of byCategory) {
    const systemPrompt = getPromptForCategory(category);
    const userContent = categoryIssues
      .map(
        (issue) =>
          `### Violation: ${issue.rule} (${issue.impact})\nID: ${issue.id}\nDescription: ${issue.description}\nCurrent HTML:\n\`\`\`html\n${issue.surroundingHtml || issue.html}\n\`\`\`\nSelector: ${issue.selector}`,
      )
      .join("\n\n");

    const response = await llmClient.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Page: ${categoryIssues[0].url}\n\n${userContent}` },
      ],
      "enrichment",
    );

    if (response) {
      const fixes = parseFixes(response.content);
      for (const fix of fixes) {
        fixMap.set(fix.issueId, fix.suggestedFix);
      }
    }
  }

  // Apply fixes back to issues
  return issues.map((issue) => {
    const fix = fixMap.get(issue.id);
    if (fix) {
      return {
        ...issue,
        suggestedFix: fix,
        fixConfidence: "unvalidated, requires human review" as const,
      };
    }
    return issue;
  });
}

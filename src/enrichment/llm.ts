// src/enrichment/llm.ts
import type { Issue } from "../types/issue.ts";
import type { LLMClient } from "../llm/client.ts";
import {
  getSystemPrompt,
  buildEnrichUserMessage,
  parseEnrichResponse,
  type PageScreenshots,
} from "./prompts.ts";

/**
 * Enrich issues with LLM-generated fix suggestions.
 * One call per violation (Málaga approach).
 * Visual violations use enrichVisualClient (vision + reasoning).
 * All others use enrichClient.
 */
const ENRICH_CONCURRENCY = 5;

export async function enrichIssues(
  issues: Issue[],
  screenshots: PageScreenshots,
  enrichClient: LLMClient,
  enrichVisualClient: LLMClient,
): Promise<Issue[]> {
  if (issues.length === 0) return issues;

  const results: Issue[] = [];

  for (let i = 0; i < issues.length; i += ENRICH_CONCURRENCY) {
    const batch = issues.slice(i, i + ENRICH_CONCURRENCY);
    const enrichedBatch = await Promise.all(
      batch.map((issue) =>
        enrichSingleIssue(
          issue,
          screenshots,
          issue.violationCategory === "visual" ? enrichVisualClient : enrichClient,
        )
      ),
    );
    results.push(...enrichedBatch);
  }

  return results;
}

/**
 * Enrich a single issue. Returns issue unchanged if LLM fails.
 */
export async function enrichSingleIssue(
  issue: Issue,
  screenshots: PageScreenshots,
  client: LLMClient,
): Promise<Issue> {
  // color-contrast requires brand/design decision — hardcode MANUAL_REVIEW without LLM call
  if (issue.rule === "color-contrast") {
    return {
      ...issue,
      suggestedFix:
        "MANUAL_REVIEW: Color contrast is a design/brand decision. " +
        "Minimum required ratios: 4.5:1 for normal text, 3:1 for large text (>=18pt or >=14pt bold) and UI components.",
      fixConfidence: "unvalidated, requires human review",
      llmConfidence: "low",
      wcagCriterion: "1.4.3",
    };
  }

  const systemPrompt = getSystemPrompt(issue.violationCategory);
  const userMessage = buildEnrichUserMessage(issue, screenshots);

  const response = await client.chat(
    [
      { role: "system", content: systemPrompt },
      userMessage,
    ],
    "enrichment",
  );

  if (!response) return issue;

  const parsed = parseEnrichResponse(response.content);
  if (!parsed) return issue;

  return {
    ...issue,
    suggestedFix: parsed.fix,
    fixConfidence: "unvalidated, requires human review",
    llmConfidence: parsed.confidence,
    wcagCriterion: parsed.wcag || null,
  };
}

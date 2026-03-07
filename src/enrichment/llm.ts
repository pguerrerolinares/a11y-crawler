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
export async function enrichIssues(
  issues: Issue[],
  screenshots: PageScreenshots,
  enrichClient: LLMClient,
  enrichVisualClient: LLMClient,
): Promise<Issue[]> {
  if (issues.length === 0) return issues;

  const results: Issue[] = [];

  for (const issue of issues) {
    const enriched = await enrichSingleIssue(
      issue,
      screenshots,
      issue.violationCategory === "visual" ? enrichVisualClient : enrichClient,
    );
    results.push(enriched);
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
  };
}

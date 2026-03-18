// src/analyzer/wcag-sensory-instructions.ts
import type { Page } from "playwright";
import type { Issue } from "../types/issue";
import type { LLMClient } from "../llm/client";
import { extractJsonFromLlm } from "../llm/client";

function makeSensoryIssue(
  url: string, description: string, selector: string,
  confidence: "high" | "medium" | "low",
): Issue {
  return {
    id: crypto.randomUUID(), url, rule: "sensory-instruction",
    impact: "moderate", description,
    help: "Instructions must not rely solely on sensory characteristics (shape, color, size, visual location, orientation, sound).",
    helpUrl: "https://www.w3.org/WAI/WCAG22/Understanding/sensory-characteristics",
    wcagTags: ["wcag133"],
    selector, html: "", surroundingHtml: "", xpath: "",
    viewportWidth: 0, pageTitle: "",
    checkSource: "llm",
    suggestedFix: null, fixConfidence: null,
    llmConfidence: confidence, wcagCriterion: "1.3.3",
    violationCategory: "structural",
  };
}

/**
 * WCAG 1.3.3 — Sensory Characteristics: detect instructions that rely solely
 * on visual/sensory properties (position, color, shape, size, sound).
 *
 * Extracts text from form areas and instruction blocks, sends to LLM for analysis.
 * Only runs if LLMClient is available.
 */
export async function testSensoryInstructions(
  page: Page,
  url: string,
  llmClient: LLMClient | null = null,
): Promise<Issue[]> {
  if (!llmClient) return [];

  // Extract instruction text from the page
  const instructionBlocks = await page.evaluate(() => {
    const results: Array<{ text: string; selector: string }> = [];

    const containers = document.querySelectorAll(
      "form, [role='form'], fieldset, legend, .instructions, .help-text, " +
      "[class*='instruction'], [class*='helper'], [class*='hint'], " +
      "[class*='description'], label, .form-text, .field-description",
    );

    for (const c of containers) {
      const text = c.textContent?.trim();
      if (!text || text.length < 10 || text.length > 500) continue;

      const selector = c.id ? `#${c.id}` :
        c.className && typeof c.className === "string"
          ? `${c.tagName.toLowerCase()}.${c.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : c.tagName.toLowerCase();

      results.push({ text, selector });
    }

    // Also check for standalone instruction paragraphs near forms
    document.querySelectorAll("form p, form span, fieldset p").forEach((el) => {
      const text = el.textContent?.trim();
      if (!text || text.length < 10 || text.length > 300) return;
      // Skip labels and buttons
      if (el.closest("label, button")) return;

      const selector = el.id ? `#${el.id}` :
        el.className && typeof el.className === "string"
          ? `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : el.tagName.toLowerCase();

      results.push({ text, selector });
    });

    return results;
  });

  if (instructionBlocks.length === 0) return [];

  // Deduplicate and limit
  const seen = new Set<string>();
  const unique = instructionBlocks.filter((b) => {
    if (seen.has(b.text)) return false;
    seen.add(b.text);
    return true;
  }).slice(0, 10);

  // Batch all texts into a single LLM call
  const textList = unique.map((b, i) => `[${i}] "${b.text}"`).join("\n");

  const prompt = `You are a WCAG accessibility expert analyzing SC 1.3.3 (Sensory Characteristics).

Analyze each instruction below. Flag any that rely SOLELY on:
- Visual position: "above", "below", "to the right", "the field on the left", "the top section"
- Color: "fields in red", "the green button", "marked in red"
- Shape/size: "the round icon", "the large button", "the square checkbox"
- Sound: "after the beep", "when you hear the tone"

Instructions that USE these terms but ALSO provide a non-sensory alternative are OK.
Example violation: "Fill in the fields marked in red"
Example OK: "Required fields are marked with an asterisk (*) in red"

Instructions:
${textList}

Respond with JSON only:
{"violations": [{"index": 0, "confidence": "high"|"medium"|"low", "reason": "one sentence"}]}

If no violations found, respond: {"violations": []}`;

  const response = await llmClient.chat(
    [{ role: "user", content: prompt }],
    "enrichment",
  );

  if (!response) return [];

  const parsed = extractJsonFromLlm(response.content) as { violations: Array<{ index: number; confidence: "high" | "medium" | "low"; reason: string }> } | null;
  if (!parsed?.violations) return [];

  return parsed.violations
    .filter((v) => v.index >= 0 && v.index < unique.length)
    .map((v) => {
      const block = unique[v.index];
      return makeSensoryIssue(
        url,
        `Instruction "${block.text.slice(0, 60)}..." relies on sensory characteristics: ${v.reason} (WCAG 1.3.3)`,
        block.selector,
        v.confidence,
      );
    });
}

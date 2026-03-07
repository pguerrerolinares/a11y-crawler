import type { PageRepresentation, NavTarget } from "../types/page.ts";
import { type LLMClient, extractJsonFromLlm } from "../llm/client.ts";

const NAV_SYSTEM_PROMPT = `You are a web navigation analyzer. Given a page representation, identify interactive elements that reveal additional navigation (menus, dropdowns, accordions, tab panels) or link to other sections of the same website.

Return ONLY a JSON array. Each object must have:
- "selector": a CSS selector that uniquely identifies the element
- "description": what the element is (e.g., "Services dropdown menu")
- "expectedBehavior": one of "navigate", "expand", "reveal"
- "confidence": 0.0 to 1.0

Rules:
- Include: main nav, secondary nav, hamburger/mobile toggles, dropdown triggers, tab panels, accordion headers, breadcrumbs, skip-links
- Exclude: search inputs, login/logout, cookie banners, social share buttons, external links, modals unrelated to navigation
- Return ONLY a JSON array, no prose
- Maximum 10 targets; omit targets with confidence < 0.5
- VALID selectors: button, a, [role="button"], button:has-text('text'), a:has-text('text'), [aria-label="text"]
- INVALID: never use "link:" prefix — it is not a valid selector. Use "a:" or [role="link"] instead
- Prefer specific selectors over generic ones — avoid bare "button" or bare "a" without additional qualifier`;

export function buildNavPrompt(
  url: string,
  title: string,
  repr: PageRepresentation,
): { system: string; user: string } {
  return {
    system: NAV_SYSTEM_PROMPT,
    user: `Page URL: ${url}\nPage title: ${title}\nRepresentation (${repr.tier}):\n\n${repr.content}`,
  };
}

/**
 * Call LLM to discover navigation targets on the page.
 */
export async function discoverNavTargets(
  url: string,
  title: string,
  repr: PageRepresentation,
  llmClient: LLMClient,
): Promise<NavTarget[]> {
  const prompt = buildNavPrompt(url, title, repr);

  const response = await llmClient.chat(
    [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    "navigation",
  );

  if (!response) return [];
  return parseNavTargets(response.content);
}

/**
 * Parse LLM response into NavTarget array.
 */
export function parseNavTargets(response: string): NavTarget[] {
  const parsed = extractJsonFromLlm(response);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (t: any) =>
        t.selector &&
        t.description &&
        t.expectedBehavior &&
        typeof t.confidence === "number" &&
        t.confidence >= 0.5,
    )
    .slice(0, 10)
    .map((t: any) => ({
      selector: String(t.selector),
      description: String(t.description),
      expectedBehavior: t.expectedBehavior as NavTarget["expectedBehavior"],
      confidence: Number(t.confidence),
    }));
}

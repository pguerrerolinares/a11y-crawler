export const TIER3_PROMPTS: Record<string, string> = {
  "color-use-link": `You are analyzing links for WCAG 1.4.1 (Use of Color).

For each marked element, reason step by step:
1. What information does this element convey? (navigation target, status, etc.)
2. In the image, is this element still distinguishable from surrounding text?
3. Are there non-color indicators? (underline, icon, border, font weight change)
4. Conclusion: violation yes/no

Elements:
{{elements}}

Respond with JSON array: [{ "element": 1, "hasViolation": bool, "confidence": "high"|"medium"|"low", "reasoning": "one sentence" }]`,

  "color-use-status": `You are analyzing status indicators for WCAG 1.4.1 (Use of Color).

For each marked element, reason step by step:
1. What status or state does this element convey? (error, success, warning, info)
2. Is this status conveyed only through color, or are there other indicators? (icon, text label, pattern, shape)
3. If color were removed or changed, would the meaning still be clear?
4. Conclusion: violation yes/no

Elements:
{{elements}}

Respond with JSON array: [{ "element": 1, "hasViolation": bool, "confidence": "high"|"medium"|"low", "reasoning": "one sentence" }]`,

  "sensory-instructions": `You are analyzing form instructions for WCAG 1.3.3 (Sensory Characteristics).

For each marked element, reason step by step:
1. What instruction or label does this element provide?
2. Does it reference shape, color, size, or position (e.g. "click the green button", "see the form on the right")?
3. Would a user who cannot see or perceive these sensory characteristics understand the instruction?
4. Conclusion: violation yes/no

Elements:
{{elements}}

Respond with JSON array: [{ "element": 1, "hasViolation": bool, "confidence": "high"|"medium"|"low", "reasoning": "one sentence" }]`,
};

export interface Tier3AnalysisResult {
  element: number;
  hasViolation: boolean;
  confidence: "high" | "medium" | "low";
  reasoning: string;
}

export function renderPrompt(promptType: string, elementsDescription: string): string {
  const template = TIER3_PROMPTS[promptType];
  if (!template) throw new Error(`Unknown prompt type: ${promptType}`);
  return template.replace("{{elements}}", elementsDescription);
}

export function parseTier3Response(content: string): Tier3AnalysisResult[] {
  try {
    // Extract JSON array from response (may have markdown code blocks)
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(item => ({
      element: item.element ?? 1,
      hasViolation: Boolean(item.hasViolation),
      confidence: (["high", "medium", "low"].includes(item.confidence) ? item.confidence : "medium") as "high" | "medium" | "low",
      reasoning: item.reasoning ?? "",
    }));
  } catch {
    return [];
  }
}

/**
 * Tier 1: CSSOM-based hover contrast analysis with fingerprint amplification.
 *
 * For each style group:
 *  - Runs buildCssomHoverQuery() on the representative element via page.evaluate
 *  - Calls evaluateHoverContrast() to decide pass / fail / ambiguous / no-change
 *  - "fail"      → amplify issues to all members (skip them in Tier 2)
 *  - "pass"      → skip all members (skippedByFingerprint++)
 *  - "ambiguous" / "no-change" → promote representative to Tier 2
 */

import type { Page } from "playwright";
import type { Issue } from "../types/issue";
import type { ElementManifest, StyleGroup } from "../types/manifest";
import { evaluateHoverContrast, buildCssomHoverQuery } from "./tier1-cssom";
import type { TierTimer } from "./tier-timer";

/** Minimal shape of an issue produced by Tier 1 / evaluateHoverContrast callers */
interface MinimalIssue {
  ruleId?: string;
  rule?: string;
  selector: string;
  severity?: string;
  impact?: string;
  message?: string;
  description?: string;
  wcagCriterion?: string | null;
  [key: string]: unknown;
}

/**
 * Amplify representative issues to every member of the style group.
 * Replaces each issue's selector with the member's selector.
 * Returns [] if representativeIssues is empty.
 */
export function amplifyResults(
  representativeIssues: MinimalIssue[],
  members: ElementManifest[],
  ruleId: string,
): Issue[] {
  if (representativeIssues.length === 0) return [];

  const amplified: Issue[] = [];

  for (const member of members) {
    for (const repIssue of representativeIssues) {
      amplified.push({
        id: crypto.randomUUID(),
        url: (repIssue.url as string) ?? "",
        rule: repIssue.rule ?? repIssue.ruleId ?? ruleId,
        impact: (repIssue.impact as Issue["impact"]) ?? "moderate",
        description: repIssue.description ?? repIssue.message ?? "",
        help: (repIssue.help as string) ?? "",
        helpUrl: (repIssue.helpUrl as string) ?? "",
        wcagTags: (repIssue.wcagTags as string[]) ?? [],
        selector: member.selector,
        html: (repIssue.html as string) ?? "",
        surroundingHtml: (repIssue.surroundingHtml as string) ?? "",
        xpath: (repIssue.xpath as string) ?? "",
        viewportWidth: (repIssue.viewportWidth as number) ?? 1280,
        pageTitle: (repIssue.pageTitle as string) ?? "",
        checkSource: (repIssue.checkSource as Issue["checkSource"]) ?? "wcag-custom",
        suggestedFix: (repIssue.suggestedFix as string | null) ?? null,
        fixConfidence: null,
        llmConfidence: (repIssue.llmConfidence as Issue["llmConfidence"]) ?? null,
        wcagCriterion: repIssue.wcagCriterion ?? null,
        violationCategory:
          (repIssue.violationCategory as Issue["violationCategory"]) ?? "visual",
      });
    }
  }

  return amplified;
}

/**
 * Run Tier 1 CSSOM analysis over all style groups.
 *
 * @returns issues found (amplified to all members on fail) and
 *          promotedElements (representatives that need Tier 2 interaction).
 */
export async function runTier1(
  page: Page,
  groups: StyleGroup[],
  url: string,
  timer: TierTimer,
): Promise<{ issues: Issue[]; promotedElements: ElementManifest[] }> {
  timer.startTier("tier1");

  const issues: Issue[] = [];
  const promotedElements: ElementManifest[] = [];
  let skippedByFingerprint = 0;

  const hoverQueryFn = buildCssomHoverQuery();

  for (const group of groups) {
    const rep = group.representative;

    // Inject the CSSOM query function into the page and run it for this element
    const hoverStyles = await page.evaluate(
      ({ sel, queryFn }) => {
        const fn = new Function(queryFn + "; return getHoverRules;")();
        const el = document.querySelector(sel);
        if (!el) return null;
        return fn(el) as Record<string, string> | null;
      },
      { sel: rep.selector, queryFn: hoverQueryFn },
    );

    const result = evaluateHoverContrast(
      rep.defaultStyles as unknown as Record<string, string>,
      hoverStyles,
      rep.parentBg,
    );

    if (result === "fail") {
      // Build a minimal representative issue and amplify to all members
      const repIssue: MinimalIssue = {
        url,
        rule: "state-change-low-contrast",
        impact: "moderate",
        description:
          "Visual state change (hover) does not meet WCAG 1.4.11 non-text contrast (≥ 3:1).",
        help: "Visual state changes must have ≥ 3:1 contrast difference so users can perceive the change.",
        helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast.html",
        wcagTags: ["wcag1411"],
        selector: rep.selector,
        html: "",
        surroundingHtml: "",
        xpath: "",
        viewportWidth: 1280,
        pageTitle: "",
        checkSource: "wcag-custom",
        suggestedFix: null,
        fixConfidence: null,
        llmConfidence: null,
        wcagCriterion: "1.4.11",
        violationCategory: "visual",
      };

      const amplified = amplifyResults([repIssue], group.members, "state-change-low-contrast");
      issues.push(...amplified);
    } else if (result === "pass") {
      // All members share the same fingerprint and pass — skip Tier 2
      skippedByFingerprint += group.members.length;
    } else {
      // "ambiguous" or "no-change" → promote representative to Tier 2
      promotedElements.push(rep);
    }
  }

  timer.endTier("tier1", {
    issuesFound: issues.length,
    elementsPromotedToTier2: promotedElements.length,
    skippedByFingerprint,
  });

  return { issues, promotedElements };
}

// frontend/src/components/coverage-summary.tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle, AlertTriangle, XCircle } from "lucide-react";

interface CoverageSummaryProps {
  detectedRules: string[];
}

const CRITERIA_COVERAGE = [
  { criterion: "1.1.1", name: "Non-text Content", method: "axe-core", rules: ["image-alt", "input-image-alt", "svg-img-alt"] },
  { criterion: "1.3.1", name: "Info and Relationships", method: "axe + heuristics", rules: ["region", "landmark-one-main", "list", "listitem", "heading-order", "semantic-pseudo-heading", "semantic-pseudo-list", "semantic-missing-fieldset"] },
  { criterion: "1.3.2", name: "Meaningful Sequence", method: "Kendall tau", rules: ["meaningful-sequence", "meaningful-sequence-reorder"] },
  { criterion: "1.4.1", name: "Use of Color", method: "CVD simulation + LLM", rules: ["color-use-link-color-only", "color-use-status-color-only", "color-use-cvd", "color-use-llm"] },
  { criterion: "1.4.3", name: "Contrast (Minimum)", method: "axe-core", rules: ["color-contrast"] },
  { criterion: "1.4.4", name: "Resize Text", method: "zoom simulation", rules: ["resize-text"] },
  { criterion: "1.4.10", name: "Reflow", method: "viewport 320px", rules: ["reflow"] },
  { criterion: "1.4.11", name: "Non-text Contrast", method: "contrast math", rules: ["non-text-contrast"] },
  { criterion: "1.4.12", name: "Text Spacing", method: "CSS injection", rules: ["text-spacing"] },
  { criterion: "1.4.13", name: "Content on Hover/Focus", method: "state machine", rules: ["hover-focus-not-persistent", "hover-focus-not-hoverable", "hover-focus-not-dismissible"] },
  { criterion: "2.1.1", name: "Keyboard", method: "interactive test", rules: ["keyboard-trap", "custom-element-not-focusable", "keyboard-operability"] },
  { criterion: "2.4.1", name: "Bypass Blocks", method: "axe + interactive", rules: ["bypass", "skip-navigation-missing", "skip-navigation-broken"] },
  { criterion: "2.4.3", name: "Focus Order", method: "tab order test", rules: ["tabindex-positive", "focus-not-visible"] },
  { criterion: "2.4.7", name: "Focus Visible", method: "focus style diff", rules: ["focus-indicator-missing"] },
  { criterion: "2.5.8", name: "Target Size", method: "bounding rect", rules: ["target-size"] },
  { criterion: "3.1.1", name: "Language of Page", method: "axe-core", rules: ["html-has-lang", "html-lang-valid"] },
  { criterion: "3.3.1", name: "Error Identification", method: "checkValidity", rules: ["error-identification"] },
  { criterion: "4.1.2", name: "Name, Role, Value", method: "axe + ARIA states", rules: ["button-name", "link-name", "label", "select-name", "aria-state-missing"] },
  { criterion: "4.1.3", name: "Status Messages", method: "MutationObserver", rules: ["status-message-no-live-region"] },
];

const NOT_COVERED = [
  { criterion: "1.3.3", name: "Sensory Characteristics", note: "LLM text analysis (requires forms with instructions)" },
  { criterion: "2.2.1", name: "Timing Adjustable", note: "Partial — detects meta refresh and autoplay" },
  { criterion: "2.4.4", name: "Link Purpose", note: "Partial — axe checks link names exist but not their quality" },
];

export function CoverageSummary({ detectedRules }: CoverageSummaryProps) {
  const ruleSet = new Set(detectedRules);

  const withFindings = CRITERIA_COVERAGE.filter(c => c.rules.some(r => ruleSet.has(r)));
  const noFindings = CRITERIA_COVERAGE.filter(c => !c.rules.some(r => ruleSet.has(r)));

  const totalCriteria = CRITERIA_COVERAGE.length + NOT_COVERED.length;
  const coveragePercent = Math.round((CRITERIA_COVERAGE.length / totalCriteria) * 100);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">WCAG 2.2 AA Coverage</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">{coveragePercent}%</div>
          <p className="text-sm text-muted-foreground mt-1">
            {CRITERIA_COVERAGE.length} of {totalCriteria} criteria covered by automated testing.{" "}
            {withFindings.length} criteria had findings in this audit.
          </p>
          <p className="text-xs text-muted-foreground mt-2">
            A manual audit typically costs thousands of euros and covers 5–10 pages.
            This scan analyzed all pages automatically for ~$0.05.
          </p>
        </CardContent>
      </Card>

      {withFindings.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Criteria with Findings ({withFindings.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {withFindings.map(c => (
                <div key={c.criterion} className="flex items-center gap-2 text-sm">
                  <XCircle className="h-4 w-4 text-red-500 shrink-0" />
                  <span className="font-mono text-xs w-10">{c.criterion}</span>
                  <span>{c.name}</span>
                  <span className="text-muted-foreground text-xs ml-auto">{c.method}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {noFindings.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Criteria Tested — No Issues ({noFindings.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {noFindings.map(c => (
                <div key={c.criterion} className="flex items-center gap-2 text-sm">
                  <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
                  <span className="font-mono text-xs w-10">{c.criterion}</span>
                  <span>{c.name}</span>
                  <span className="text-muted-foreground text-xs ml-auto">{c.method}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Requires Manual Review ({NOT_COVERED.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-1">
            {NOT_COVERED.map(c => (
              <div key={c.criterion} className="flex items-center gap-2 text-sm">
                <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0" />
                <span className="font-mono text-xs w-10">{c.criterion}</span>
                <span>{c.name}</span>
                <span className="text-muted-foreground text-xs ml-auto">{c.note}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

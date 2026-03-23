import { CRITERION_META, CATEGORY_META } from "./wcag-metadata";
import { getDb } from "../server/db/client";

export interface ComplianceRow {
  criterion: string;
  name: string;
  level: "A" | "AA" | "AAA";
  status: "pass" | "fail";
  issueCount: number;
}

export interface IssueInstance {
  url: string;
  selector: string;
  html: string;
}

export interface Finding {
  criterion: string;
  controlName: string;
  level: "A" | "AA" | "AAA";
  status: "fail";
  requirement: string;
  finding: string;
  remediation: string;
  affectedPages: string[];
  issueCount: number;
  instances?: IssueInstance[]; // only in "full" detail
}

export interface CategorySection {
  id: string;
  name: string;
  description: string;
  findings: Finding[];
}

export interface ReportData {
  meta: {
    baseUrl: string;
    date: string;
    wcagLevel: "AA";
    toolVersions: { crawler: string; axeCore: string };
    totalDurationSeconds: number;
    detailLevel: "standard" | "full";
  };
  score: {
    value: number;
    totalIssues: number;
    totalPages: number;
    issuesByImpact: Record<string, number>;
  };
  complianceTable: ComplianceRow[];
  categories: CategorySection[];
  analyzedUrls: Array<{ url: string; issueCount: number }>;
}

export interface IssueRow {
  report_category: string;
  wcag_criterion: string;
  rule: string;
  impact: string;
  description: string;
  help: string;
  suggested_fix: string | null;
  url: string;
  selector: string;
  html: string;
}

/**
 * Build the compliance table from CRITERION_META, marking each criterion
 * as pass or fail based on the issueCounts map.
 */
export function buildComplianceTable(issueCounts: Map<string, number>): ComplianceRow[] {
  const rows: ComplianceRow[] = Object.entries(CRITERION_META).map(([criterion, meta]) => {
    const count = issueCounts.get(criterion) ?? 0;
    return {
      criterion,
      name: meta.name,
      level: meta.level,
      status: count > 0 ? "fail" : "pass",
      issueCount: count,
    };
  });

  // Sort by criterion number (e.g., 1.1.1, 1.2.1, 2.1.1)
  rows.sort((a, b) => {
    const aParts = a.criterion.split(".").map(Number);
    const bParts = b.criterion.split(".").map(Number);
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });

  return rows;
}

/**
 * Group issues by report_category, then by wcag_criterion, consolidating
 * into Finding objects. Categories are ordered by CATEGORY_META key order.
 */
export function groupByCategory(
  issues: IssueRow[],
  detail: "standard" | "full"
): CategorySection[] {
  // Group by category then criterion
  const byCategoryByCriterion = new Map<string, Map<string, IssueRow[]>>();

  for (const issue of issues) {
    let byCriterion = byCategoryByCriterion.get(issue.report_category);
    if (!byCriterion) {
      byCriterion = new Map();
      byCategoryByCriterion.set(issue.report_category, byCriterion);
    }
    let criterionIssues = byCriterion.get(issue.wcag_criterion);
    if (!criterionIssues) {
      criterionIssues = [];
      byCriterion.set(issue.wcag_criterion, criterionIssues);
    }
    criterionIssues.push(issue);
  }

  // Build sections ordered by CATEGORY_META key order
  const sections: CategorySection[] = [];

  for (const [categoryId, categoryMeta] of Object.entries(CATEGORY_META)) {
    const byCriterion = byCategoryByCriterion.get(categoryId);
    if (!byCriterion || byCriterion.size === 0) continue;

    const findings: Finding[] = [];

    for (const [criterion, criterionIssues] of byCriterion) {
      const meta = CRITERION_META[criterion];
      const affectedPages = [...new Set(criterionIssues.map(i => i.url))];

      // Most common description (or first)
      const descCounts = new Map<string, number>();
      for (const issue of criterionIssues) {
        descCounts.set(issue.description, (descCounts.get(issue.description) ?? 0) + 1);
      }
      let mostCommonDesc = criterionIssues[0].description;
      let maxCount = 0;
      for (const [desc, count] of descCounts) {
        if (count > maxCount) {
          maxCount = count;
          mostCommonDesc = desc;
        }
      }

      // First non-null suggested_fix, falling back to help
      const remediation =
        criterionIssues.find(i => i.suggested_fix != null)?.suggested_fix ??
        criterionIssues[0].help;

      const finding: Finding = {
        criterion,
        controlName: meta?.name ?? criterion,
        level: meta?.level ?? "AA",
        status: "fail",
        requirement: "",
        finding: mostCommonDesc,
        remediation,
        affectedPages,
        issueCount: criterionIssues.length,
      };

      if (detail === "full") {
        finding.instances = criterionIssues.map(i => ({
          url: i.url,
          selector: i.selector,
          html: i.html,
        }));
      }

      findings.push(finding);
    }

    // Sort findings by criterion number
    findings.sort((a, b) => {
      const aParts = a.criterion.split(".").map(Number);
      const bParts = b.criterion.split(".").map(Number);
      for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    });

    sections.push({
      id: categoryId,
      name: categoryMeta.name,
      description: categoryMeta.description,
      findings,
    });
  }

  return sections;
}

/**
 * Build the full ReportData for an audit by querying the database.
 */
export async function buildReportData(
  auditId: string,
  detail: "standard" | "full"
): Promise<ReportData> {
  const db = getDb();

  const [audit] = await db`
    SELECT id, url, status, wcag_score, duration_seconds
    FROM audits
    WHERE id = ${auditId}
  `;

  if (!audit) {
    throw new Error(`Audit not found: ${auditId}`);
  }

  const issues = await db`
    SELECT i.rule, i.impact, i.description, i.help, i.suggested_fix,
           i.report_category, i.wcag_criterion, i.selector, i.html,
           p.url
    FROM issues i
    JOIN pages p ON p.id = i.page_id
    WHERE i.audit_id = ${auditId}
  ` as IssueRow[];

  const analyzedUrlsRaw = await db`
    SELECT p.url, COUNT(i.id)::int as issue_count
    FROM pages p
    LEFT JOIN issues i ON i.page_id = p.id AND i.audit_id = ${auditId}
    WHERE p.audit_id = ${auditId}
    GROUP BY p.url
    ORDER BY issue_count DESC
  ` as Array<{ url: string; issue_count: number }>;

  const analyzedUrls = analyzedUrlsRaw.map(r => ({
    url: r.url,
    issueCount: r.issue_count,
  }));

  // Build issueCounts by wcag_criterion
  const issueCounts = new Map<string, number>();
  for (const issue of issues) {
    if (issue.wcag_criterion) {
      issueCounts.set(issue.wcag_criterion, (issueCounts.get(issue.wcag_criterion) ?? 0) + 1);
    }
  }

  // Build issuesByImpact — initialize all levels to 0 so template never hits missing keys
  const issuesByImpact: Record<string, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const issue of issues) {
    issuesByImpact[issue.impact] = (issuesByImpact[issue.impact] ?? 0) + 1;
  }

  const complianceTable = buildComplianceTable(issueCounts);
  const categories = groupByCategory(issues, detail);

  return {
    meta: {
      baseUrl: audit.url as string,
      date: new Date().toISOString(),
      wcagLevel: "AA",
      toolVersions: { crawler: "7.3.0", axeCore: "4.11.1" },
      totalDurationSeconds: (audit.duration_seconds as number) ?? 0,
      detailLevel: detail,
    },
    score: {
      value: (audit.wcag_score as number) ?? 100,
      totalIssues: issues.length,
      totalPages: analyzedUrls.length,
      issuesByImpact,
    },
    complianceTable,
    categories,
    analyzedUrls,
  };
}

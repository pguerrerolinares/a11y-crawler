import { getDb } from "../db/client.ts";
import { extractWcagCriterion } from "../utils/wcag.ts";
import { buildReportData } from "../../reporter/report-data";
import { renderPdf } from "../../reporter/typst-renderer";

export async function handleExport(req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET") {
    return Response.json({ error: "Method Not Allowed" }, { status: 405 });
  }

  const match = url.pathname.match(/^\/api\/audits\/([^/]+)\/export\/(csv|pdf)$/);
  if (!match) return Response.json({ error: "Not Found" }, { status: 404 });

  const [, auditId, format] = match;

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(auditId)) {
    return Response.json({ error: "Invalid audit ID" }, { status: 400 });
  }

  // Validate audit exists and is completed
  const db = getDb();
  const [audit] = await db`SELECT id, url, status FROM audits WHERE id = ${auditId}`;
  if (!audit) return Response.json({ error: "Audit not found" }, { status: 404 });
  if (audit.status !== "completed" && audit.status !== "completed-base") {
    return Response.json({ error: "Audit not completed yet" }, { status: 409 });
  }

  if (format === "csv") return exportCsv(auditId);
  if (format === "pdf") return exportPdf(auditId, url);

  return Response.json({ error: "Not Found" }, { status: 404 });
}

async function exportCsv(auditId: string): Promise<Response> {
  const db = getDb();

  const CSV_HEADERS = [
    "rule", "impact", "category", "page_url", "selector",
    "description", "help", "wcag_tags", "wcag_criterion", "llm_confidence", "suggested_fix",
  ];

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const encoder = new TextEncoder();

        // Header row
        controller.enqueue(encoder.encode(CSV_HEADERS.join(",") + "\r\n"));

        // Stream issues in batches of 500
        const BATCH = 500;
        let offset = 0;

        while (true) {
          const issues = await db`
            SELECT i.rule, i.impact, i.category, i.selector, i.description,
                   i.help, i.wcag_tags, i.llm_confidence, i.suggested_fix, i.page_id
            FROM issues i
            WHERE i.audit_id = ${auditId}
            ORDER BY i.impact, i.rule
            LIMIT ${BATCH} OFFSET ${offset}
          `;

          if (issues.length === 0) break;

          // Resolve page URLs in batch
          const pageIds = [...new Set(issues.map((i: Record<string, unknown>) => i.page_id as string))];
          const pages = await db`SELECT id, url FROM pages WHERE id IN ${db(pageIds)}`;
          const pageUrlMap = new Map(pages.map((p: Record<string, unknown>) => [p.id as string, p.url as string]));

          for (const issue of issues) {
            const row = [
              issue.rule,
              issue.impact,
              issue.category ?? "",
              pageUrlMap.get(issue.page_id) ?? "",
              issue.selector ?? "",
              issue.description ?? "",
              issue.help ?? "",
              Array.isArray(issue.wcag_tags)
                ? issue.wcag_tags.join(";")
                : (typeof issue.wcag_tags === "string" ? issue.wcag_tags : ""),
              extractWcagCriterion(issue.wcag_tags, issue.rule) ?? "",
              issue.llm_confidence ?? "",
              issue.suggested_fix ?? "",
            ].map(csvEscape).join(",");

            controller.enqueue(encoder.encode(row + "\r\n"));
          }

          offset += issues.length;
          if (issues.length < BATCH) break;
        }

        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  const filename = `audit-${auditId.slice(0, 8)}.csv`;
  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

async function exportPdf(auditId: string, url: URL): Promise<Response> {
  const detailParam = url.searchParams.get("detail") ?? "standard";
  if (!["standard", "full"].includes(detailParam)) {
    return Response.json({ error: "Invalid detail level. Use 'standard' or 'full'" }, { status: 400 });
  }
  const detail = detailParam as "standard" | "full";

  try {
    const reportData = await buildReportData(auditId, detail);
    const pdfBuffer = await renderPdf(reportData);

    const date = new Date().toISOString().slice(0, 10);
    const filename = `audit-${auditId.slice(0, 8)}-${date}-${detail}.pdf`;

    return new Response(pdfBuffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error("PDF generation failed:", err);
    return Response.json({ error: "PDF generation failed" }, { status: 500 });
  }
}

/** Escape a CSV field value: prefix dangerous leading characters, wrap in quotes if needed. */
export function csvEscape(value: unknown): string {
  let str = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(str)) {
    str = "'" + str;
  }
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

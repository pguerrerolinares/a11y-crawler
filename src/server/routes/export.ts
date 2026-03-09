import { getDb } from "../db/client.ts";
import { join } from "node:path";
import { existsSync } from "node:fs";

const reportsDir = process.env.REPORTS_DIR || "./reports";

export async function handleExport(req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET") {
    return Response.json({ error: "Method Not Allowed" }, { status: 405 });
  }

  const match = url.pathname.match(/^\/api\/audits\/([^/]+)\/export\/(csv|pdf)$/);
  if (!match) return Response.json({ error: "Not Found" }, { status: 404 });

  const [, auditId, format] = match;

  // Validate audit exists and is completed
  const db = getDb();
  const [audit] = await db`SELECT id, url, status FROM audits WHERE id = ${auditId}`;
  if (!audit) return Response.json({ error: "Audit not found" }, { status: 404 });
  if (audit.status !== "completed") {
    return Response.json({ error: "Audit not completed yet" }, { status: 409 });
  }

  if (format === "csv") return exportCsv(auditId);
  if (format === "pdf") return exportPdf(auditId);

  return Response.json({ error: "Not Found" }, { status: 404 });
}

async function exportCsv(auditId: string): Promise<Response> {
  const db = getDb();

  const CSV_HEADERS = [
    "rule", "impact", "category", "page_url", "selector",
    "description", "help", "wcag_tags", "suggested_fix",
  ];

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      // Header row
      controller.enqueue(encoder.encode(CSV_HEADERS.join(",") + "\r\n"));

      // Stream issues in batches of 500
      const BATCH = 500;
      let offset = 0;

      while (true) {
        const issues = await db`
          SELECT i.rule, i.impact, i.category, i.selector, i.description,
                 i.help, i.wcag_tags, i.suggested_fix, i.page_id
          FROM issues i
          WHERE i.audit_id = ${auditId}
          ORDER BY i.impact, i.rule
          LIMIT ${BATCH} OFFSET ${offset}
        `;

        if (issues.length === 0) break;

        // Resolve page URLs in batch
        const pageIds = [...new Set(issues.map((i: any) => i.page_id))];
        const pages = await db`SELECT id, url FROM pages WHERE id IN ${db(pageIds)}`;
        const pageUrlMap = new Map(pages.map((p: any) => [p.id, p.url]));

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
            issue.suggested_fix ?? "",
          ].map(csvEscape).join(",");

          controller.enqueue(encoder.encode(row + "\r\n"));
        }

        offset += issues.length;
        if (issues.length < BATCH) break;
      }

      controller.close();
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

async function exportPdf(auditId: string): Promise<Response> {
  const pdfPath = join(reportsDir, `${auditId}.pdf`);

  if (!existsSync(pdfPath)) {
    return Response.json(
      { error: "PDF not available. It is generated after the crawl completes." },
      { status: 404 },
    );
  }

  const file = Bun.file(pdfPath);
  const filename = `audit-${auditId.slice(0, 8)}.pdf`;

  return new Response(file, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

/** Escape a CSV field value: wrap in quotes if it contains comma, quote, or newline. */
export function csvEscape(value: unknown): string {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

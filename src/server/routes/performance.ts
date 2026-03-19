import { getDb } from "../db/client.ts";

export async function handlePerformance(req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET") return Response.json({ error: "Method Not Allowed" }, { status: 405 });

  const match = url.pathname.match(/^\/api\/audits\/([^/]+)\/performance$/);
  if (!match) return Response.json({ error: "Not Found" }, { status: 404 });

  const auditId = match[1];
  const db = getDb();

  // Fetch audit record for LLM usage
  const [audit] = await db`
    SELECT id, status, llm_usage, duration_seconds FROM audits WHERE id = ${auditId}
  `;
  if (!audit) return Response.json({ error: "Audit not found" }, { status: 404 });

  // Fetch all probe spans with tier timing metadata
  const spans = await db`
    SELECT name, duration_ms, metadata, started_at, ended_at
    FROM audit_spans
    WHERE audit_id = ${auditId}
      AND name LIKE 'probe:%'
    ORDER BY started_at ASC
  `;

  // Aggregate tier timing across all templates
  const tierSummary = {
    tier0: { totalDurationMs: 0, totalElements: 0, totalStyleGroups: 0, templates: 0 },
    tier1: { totalDurationMs: 0, totalIssues: 0, totalPromoted: 0, totalSkipped: 0, templates: 0 },
    tier2: { totalDurationMs: 0, totalIssues: 0, totalHovers: 0, totalFocuses: 0, totalClicks: 0, totalKeyboardTests: 0, templates: 0 },
    tier3: { totalDurationMs: 0, totalLlmCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalIssuesConfirmed: 0, totalCacheHits: 0, templates: 0 },
  };

  const templateTimings: Record<string, unknown>[] = [];

  for (const span of spans) {
    const meta = span.metadata as Record<string, unknown> | null;
    if (!meta?.tierTiming) continue;

    const timing = meta.tierTiming as Record<string, Record<string, number> & { interactions?: Record<string, number> }>;

    if (timing.tier0) {
      tierSummary.tier0.totalDurationMs += timing.tier0.durationMs ?? 0;
      tierSummary.tier0.totalElements += timing.tier0.elementsDiscovered ?? 0;
      tierSummary.tier0.totalStyleGroups += timing.tier0.styleGroups ?? 0;
      tierSummary.tier0.templates++;
    }
    if (timing.tier1) {
      tierSummary.tier1.totalDurationMs += timing.tier1.durationMs ?? 0;
      tierSummary.tier1.totalIssues += timing.tier1.issuesFound ?? 0;
      tierSummary.tier1.totalPromoted += timing.tier1.elementsPromotedToTier2 ?? 0;
      tierSummary.tier1.totalSkipped += timing.tier1.skippedByFingerprint ?? 0;
      tierSummary.tier1.templates++;
    }
    if (timing.tier2) {
      tierSummary.tier2.totalDurationMs += timing.tier2.durationMs ?? 0;
      tierSummary.tier2.totalIssues += timing.tier2.issuesFound ?? 0;
      tierSummary.tier2.totalHovers += timing.tier2.interactions?.hovers ?? 0;
      tierSummary.tier2.totalFocuses += timing.tier2.interactions?.focuses ?? 0;
      tierSummary.tier2.totalClicks += timing.tier2.interactions?.clicks ?? 0;
      tierSummary.tier2.totalKeyboardTests += timing.tier2.interactions?.keyboardTests ?? 0;
      tierSummary.tier2.templates++;
    }
    if (timing.tier3) {
      tierSummary.tier3.totalDurationMs += timing.tier3.durationMs ?? 0;
      tierSummary.tier3.totalLlmCalls += timing.tier3.llmCalls ?? 0;
      tierSummary.tier3.totalInputTokens += timing.tier3.llmInputTokens ?? 0;
      tierSummary.tier3.totalOutputTokens += timing.tier3.llmOutputTokens ?? 0;
      tierSummary.tier3.totalIssuesConfirmed += timing.tier3.issuesConfirmed ?? 0;
      tierSummary.tier3.totalCacheHits += timing.tier3.cacheHits ?? 0;
      tierSummary.tier3.templates++;
    }

    templateTimings.push({
      templateId: meta.templateId,
      url: meta.url,
      tierTiming: timing,
    });
  }

  const llmUsage = audit.llm_usage as Record<string, number> | null;

  return Response.json({
    auditId,
    status: audit.status,
    durationSeconds: audit.duration_seconds,
    tiers: {
      tier0: {
        ...tierSummary.tier0,
        avgDurationMsPerTemplate: tierSummary.tier0.templates
          ? Math.round(tierSummary.tier0.totalDurationMs / tierSummary.tier0.templates)
          : 0,
      },
      tier1: {
        ...tierSummary.tier1,
        avgDurationMsPerTemplate: tierSummary.tier1.templates
          ? Math.round(tierSummary.tier1.totalDurationMs / tierSummary.tier1.templates)
          : 0,
      },
      tier2: {
        ...tierSummary.tier2,
        avgDurationMsPerTemplate: tierSummary.tier2.templates
          ? Math.round(tierSummary.tier2.totalDurationMs / tierSummary.tier2.templates)
          : 0,
      },
      tier3: {
        ...tierSummary.tier3,
        avgDurationMsPerTemplate: tierSummary.tier3.templates
          ? Math.round(tierSummary.tier3.totalDurationMs / tierSummary.tier3.templates)
          : 0,
      },
    },
    llmUsage: {
      totalCalls: llmUsage?.totalCalls ?? 0,
      navigationCalls: llmUsage?.navigationCalls ?? 0,
      enrichmentCalls: llmUsage?.enrichmentCalls ?? 0,
      visionCalls: llmUsage?.visionCalls ?? 0,
      totalInputTokens: llmUsage?.totalInputTokens ?? 0,
      totalOutputTokens: llmUsage?.totalOutputTokens ?? 0,
    },
    templateTimings,
  });
}

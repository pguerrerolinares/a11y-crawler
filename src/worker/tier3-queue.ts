import type { LLMClient } from "../llm/client";
import {
  claimNextTier3Job,
  completeTier3Job,
  failTier3Job,
  allTier3JobsDone,
  tier3CacheLookup,
  tier3CacheSet,
} from "./db-tier3";
import { markAuditFullyCompleted } from "./db-audit";
import { renderPrompt, parseTier3Response } from "./tier3-prompts";

const TIER3_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CROPS_PER_BATCH = 5;

interface Tier3Element {
  selector: string;
  cropPath?: string;
  cropBase64?: string;
  context: string;
  promptType: string;
}

/**
 * Resets jobs stuck in 'running' state after a crash.
 * Should be called on worker startup.
 */
export async function resetStuckTier3Jobs(auditId: string): Promise<void> {
  const { default: postgres } = await import("postgres");
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const db = postgres(url);
  await db`
    UPDATE tier3_jobs SET status = 'pending', started_at = NULL
    WHERE audit_id = ${auditId} AND status = 'running'
  `;
  await db.end();
}

/**
 * Processes all pending Tier 3 jobs for an audit.
 * Runs batch LLM vision calls with crops, inserts confirmed issues,
 * and marks the audit as fully completed when done.
 *
 * Called as a background task after Tier 0-2 probe completes.
 */
export async function processTier3Queue(
  auditId: string,
  llmClient: LLMClient,
  insertIssuesFn: (auditId: string, issues: unknown[]) => Promise<void>,
  insertEventFn: (auditId: string, type: string, data: unknown) => Promise<void>,
): Promise<void> {
  const startTime = Date.now();

  try {
    while (true) {
      // Timeout guard
      if (Date.now() - startTime > TIER3_TIMEOUT_MS) {
        console.warn(`[tier3] Timeout reached for audit ${auditId} — marking complete`);
        await markAuditFullyCompleted(auditId);
        return;
      }

      // Check if all jobs are done
      const allDone = await allTier3JobsDone(auditId);
      if (allDone) break;

      // Claim next job
      const job = await claimNextTier3Job(auditId);
      if (!job) {
        // No pending jobs but not all done (race condition) — brief pause
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      const jobId = job.id as string;
      const elements = job.elements as Tier3Element[];
      const templateId = job.template_id as string;

      try {
        const confirmedIssues: unknown[] = [];

        // Process in batches of MAX_CROPS_PER_BATCH
        for (let i = 0; i < elements.length; i += MAX_CROPS_PER_BATCH) {
          const batch = elements.slice(i, i + MAX_CROPS_PER_BATCH);

          // Check cache for each element in batch
          const cacheResults = await Promise.all(
            batch.map((el) => {
              const cacheKey = `${el.promptType}:${el.selector}:${auditId}`;
              return tier3CacheLookup(cacheKey);
            }),
          );

          const uncachedBatch = batch.filter((_, idx) => !cacheResults[idx]);

          // Use cached results
          for (let idx = 0; idx < batch.length; idx++) {
            const cached = cacheResults[idx];
            if (cached && (cached as { hasViolation: boolean }).hasViolation) {
              confirmedIssues.push({
                selector: batch[idx].selector,
                rule: batch[idx].promptType,
                description: "Potential accessibility violation (cached LLM analysis)",
                checkSource: "llm-vision",
              });
            }
          }

          if (uncachedBatch.length === 0) continue;

          // Build batch LLM message
          const promptType = uncachedBatch[0].promptType;
          const elementsDescription = uncachedBatch
            .map((el, idx) => `[Image ${idx + 1}] ${el.context}`)
            .join("\n");

          const prompt = renderPrompt(promptType, elementsDescription);

          // Build multimodal messages with crops
          const imageContent: Array<{ type: "image_url"; image_url: { url: string; detail: "low" | "high" | "auto" } }> = [];
          for (const el of uncachedBatch) {
            if (el.cropBase64) {
              imageContent.push({
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${el.cropBase64}`,
                  detail: "low",
                },
              });
            }
          }

          const messages = [
            {
              role: "user" as const,
              content: [
                ...imageContent,
                { type: "text" as const, text: prompt },
              ],
            },
          ];

          const response = await llmClient.chatVisionBatch(messages, 1500);

          if (response) {
            const results = parseTier3Response(response.content);

            for (let idx = 0; idx < uncachedBatch.length; idx++) {
              const el = uncachedBatch[idx];
              const result = results[idx];
              if (!result) continue;

              // Cache the result
              const cacheKey = `${el.promptType}:${el.selector}:${auditId}`;
              await tier3CacheSet(cacheKey, result, "vision", auditId);

              // Early termination: skip low-confidence non-violations
              if (!result.hasViolation && result.confidence === "low") continue;

              if (result.hasViolation && result.confidence !== "low") {
                confirmedIssues.push({
                  selector: el.selector,
                  rule: el.promptType,
                  description:
                    result.reasoning ||
                    "Potential accessibility violation detected by LLM vision analysis",
                  checkSource: "llm-vision",
                  llmConfidence: result.confidence,
                  wcagCriterion: el.promptType.startsWith("color-use") ? "1.4.1" : "1.3.3",
                });
              }
            }
          }
        }

        // Insert confirmed issues
        if (confirmedIssues.length > 0) {
          await insertIssuesFn(auditId, confirmedIssues);
          await insertEventFn(auditId, "tier3:issue", {
            auditId,
            templateId,
            count: confirmedIssues.length,
          });
        }

        await completeTier3Job(jobId, { confirmedIssues: confirmedIssues.length });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[tier3] Job ${jobId} failed:`, errMsg);
        await failTier3Job(jobId, errMsg);
      }
    }

    // All jobs done
    await markAuditFullyCompleted(auditId);
    await insertEventFn(auditId, "tier3:complete", { auditId });
  } catch (err) {
    console.error(`[tier3] Queue processing failed for ${auditId}:`, err);
    await markAuditFullyCompleted(auditId).catch(() => {});
  }
}

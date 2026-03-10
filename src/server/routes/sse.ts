import { getDb } from "../db/client.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LIFETIME_MS = 30 * 60 * 1000; // 30 minutes

/**
 * SSE endpoint: GET /api/audits/:id/events
 * Streams audit progress events to the client.
 * Auto-closes when audit is completed or failed, or after 30 minutes.
 */
export function handleSSE(req: Request, url: URL): Response | null {
  const match = url.pathname.match(/^\/api\/audits\/([^/]+)\/events$/);
  if (!match || req.method !== "GET") return null;

  const auditId = match[1];
  if (!UUID_RE.test(auditId)) {
    return Response.json({ error: "Invalid audit ID" }, { status: 400 });
  }

  const db = getDb();
  const startedAt = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let lastEventId = 0;
      let closed = false;
      let heartbeatCounter = 0;

      const send = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const sendHeartbeat = () => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`:keepalive\n\n`));
        } catch {
          closed = true;
        }
      };

      // Poll for new events every 2 seconds
      const interval = setInterval(async () => {
        if (closed) {
          clearInterval(interval);
          return;
        }

        // Max lifetime guard
        if (Date.now() - startedAt > MAX_LIFETIME_MS) {
          send({ type: "timeout", data: { message: "SSE connection timed out" } });
          clearInterval(interval);
          closed = true;
          controller.close();
          return;
        }

        try {
          // Get new events since last seen
          const events = await db`
            SELECT id, event_type, data
            FROM audit_events
            WHERE audit_id = ${auditId} AND id > ${lastEventId}
            ORDER BY id
          `;

          if (events.length === 0) {
            // Send heartbeat every ~15 seconds (every 7-8 poll cycles)
            heartbeatCounter++;
            if (heartbeatCounter >= 7) {
              sendHeartbeat();
              heartbeatCounter = 0;
            }
          } else {
            heartbeatCounter = 0;
            for (const event of events) {
              send({
                type: event.event_type,
                data: typeof event.data === "string" ? JSON.parse(event.data) : event.data,
              });
              lastEventId = event.id;
            }
          }

          // Check if audit is done
          const audit = await db`
            SELECT status FROM audits WHERE id = ${auditId}
          `;

          if (audit.length === 0 || audit[0].status === "completed" || audit[0].status === "failed") {
            // Send final status if not already sent via events
            if (audit.length > 0) {
              send({ type: audit[0].status, data: { status: audit[0].status } });
            }
            clearInterval(interval);
            closed = true;
            controller.close();
          }
        } catch (err) {
          console.error("SSE poll error:", err);
        }
      }, 2000);

      // Cleanup on client disconnect
      req.signal?.addEventListener("abort", () => {
        clearInterval(interval);
        closed = true;
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

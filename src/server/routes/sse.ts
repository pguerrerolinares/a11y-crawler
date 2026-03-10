import { getDb } from "../db/client.ts";

/**
 * SSE endpoint: GET /api/audits/:id/events
 * Streams audit progress events to the client.
 * Auto-closes when audit is completed or failed.
 */
export function handleSSE(req: Request, url: URL): Response | null {
  const match = url.pathname.match(/^\/api\/audits\/([^/]+)\/events$/);
  if (!match || req.method !== "GET") return null;

  const auditId = match[1];
  const db = getDb();

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let lastEventId = 0;
      let closed = false;

      const send = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
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

        try {
          // Get new events since last seen
          const events = await db`
            SELECT id, event_type, data
            FROM audit_events
            WHERE audit_id = ${auditId} AND id > ${lastEventId}
            ORDER BY id
          `;

          for (const event of events) {
            send({
              type: event.event_type,
              data: typeof event.data === "string" ? JSON.parse(event.data) : event.data,
            });
            lastEventId = event.id;
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

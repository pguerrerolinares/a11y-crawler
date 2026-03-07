import type { ServerWebSocket } from "bun";
import { getDb } from "./db/client.ts";

interface WsData {
  auditId: string;
}

const clients = new Map<string, Set<ServerWebSocket<WsData>>>();

export function handleWsUpgrade(req: Request, server: any): Response | undefined {
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/ws\/audits\/([^/]+)$/);
  if (!match) return undefined;

  const auditId = match[1];
  const success = server.upgrade<WsData>(req, { data: { auditId } });
  if (success) return undefined;
  return new Response("WebSocket upgrade failed", { status: 400 });
}

export function wsOpen(ws: ServerWebSocket<WsData>) {
  const { auditId } = ws.data;
  if (!clients.has(auditId)) clients.set(auditId, new Set());
  clients.get(auditId)!.add(ws);
}

export function wsClose(ws: ServerWebSocket<WsData>) {
  const { auditId } = ws.data;
  clients.get(auditId)?.delete(ws);
  if (clients.get(auditId)?.size === 0) clients.delete(auditId);
}

export function wsMessage(_ws: ServerWebSocket<WsData>, _message: string | Buffer) {
  // Client-to-server messages not needed
}

export function broadcastToAudit(auditId: string, event: { type: string; data: unknown }) {
  const subs = clients.get(auditId);
  if (!subs || subs.size === 0) return;
  const msg = JSON.stringify(event);
  for (const ws of subs) {
    ws.send(msg);
  }
}

export async function startNotifyListener() {
  const db = getDb();

  // Poll audit_events for active WebSocket subscriptions
  setInterval(async () => {
    for (const auditId of clients.keys()) {
      try {
        const events = await db`
          SELECT * FROM audit_events
          WHERE audit_id = ${auditId}
          ORDER BY id DESC LIMIT 1
        `;
        if (events.length > 0) {
          broadcastToAudit(auditId, {
            type: events[0].event_type,
            data: events[0].data,
          });
        }
      } catch {}
    }
  }, 1000);
}

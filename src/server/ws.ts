import type { ServerWebSocket } from "bun";
import { getDb } from "./db/client.ts";

interface WsData {
  auditId?: string;
  mode: "audit";
}

const clients = new Map<string, Set<ServerWebSocket<WsData>>>();

export function handleWsUpgrade(req: Request, server: any): Response | undefined {
  // /ws/audits/:id — audit progress
  const match = new URL(req.url).pathname.match(/^\/ws\/audits\/([^/]+)$/);
  if (!match) return undefined;
  const auditId = match[1];
  const success = server.upgrade<WsData>(req, { data: { auditId, mode: "audit" } });
  if (success) return undefined;
  return new Response("WebSocket upgrade failed", { status: 400 });
}

export function wsOpen(ws: ServerWebSocket<WsData>) {
  const { auditId } = ws.data;
  if (!auditId) return;
  if (!clients.has(auditId)) clients.set(auditId, new Set());
  clients.get(auditId)!.add(ws);
}

export function wsClose(ws: ServerWebSocket<WsData>) {
  const { auditId } = ws.data;
  if (!auditId) return;
  clients.get(auditId)?.delete(ws);
  if (clients.get(auditId)?.size === 0) clients.delete(auditId);
}

export function wsMessage(_ws: ServerWebSocket<WsData>, _message: string | Buffer) {}

export function broadcastToAudit(auditId: string, event: { type: string; data: unknown }) {
  const subs = clients.get(auditId);
  if (!subs || subs.size === 0) return;
  const msg = JSON.stringify(event);
  for (const ws of subs) {
    ws.send(msg);
  }
}

const lastSentId = new Map<string, number>();

export async function startNotifyListener() {
  const db = getDb();

  setInterval(async () => {
    for (const auditId of clients.keys()) {
      try {
        const lastId = lastSentId.get(auditId) ?? 0;
        const events = await db`
          SELECT * FROM audit_events
          WHERE audit_id = ${auditId} AND id > ${lastId}
          ORDER BY id ASC
        `;
        for (const event of events) {
          broadcastToAudit(auditId, { type: event.event_type, data: event.data });
          lastSentId.set(auditId, event.id);
        }
      } catch (err) {
        console.error(`WS poll error for audit ${auditId}:`, err);
      }
    }
    for (const auditId of lastSentId.keys()) {
      if (!clients.has(auditId)) lastSentId.delete(auditId);
    }
  }, 1000);
}

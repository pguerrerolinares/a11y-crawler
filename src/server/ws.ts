import type { ServerWebSocket } from "bun";
import { getDb } from "./db/client.ts";

interface WsData {
  auditId?: string;
  mode: "audit" | "logs";
}

const clients = new Map<string, Set<ServerWebSocket<WsData>>>();
const logClients = new Set<ServerWebSocket<WsData>>();

// Paths to exclude from live log streaming (noise filter)
const LOG_NOISE_PATHS = ["/api/logs", "/ws", "/health"];
const LOG_NOISE_EXTENSIONS = [".js", ".css", ".svg", ".ico", ".png", ".jpg", ".woff", ".woff2"];

function isNoisyLog(path: string): boolean {
  if (LOG_NOISE_PATHS.some(p => path.startsWith(p))) return true;
  if (LOG_NOISE_EXTENSIONS.some(ext => path.endsWith(ext))) return true;
  if (path.startsWith("/assets/")) return true;
  return false;
}

export function broadcastLog(log: Record<string, unknown>) {
  if (logClients.size === 0) return;
  const path = log.path as string;
  if (isNoisyLog(path)) return;
  const msg = JSON.stringify({ type: "new_log", data: log });
  for (const ws of logClients) {
    ws.send(msg);
  }
}

export function handleWsUpgrade(req: Request, server: any): Response | undefined {
  const url = new URL(req.url);

  // /ws/logs — log streaming
  if (url.pathname === "/ws/logs") {
    const success = server.upgrade<WsData>(req, { data: { mode: "logs" } });
    if (success) return undefined;
    return new Response("WebSocket upgrade failed", { status: 400 });
  }

  // /ws/audits/:id — audit progress (existing)
  const match = url.pathname.match(/^\/ws\/audits\/([^/]+)$/);
  if (!match) return undefined;
  const auditId = match[1];
  const success = server.upgrade<WsData>(req, { data: { auditId, mode: "audit" } });
  if (success) return undefined;
  return new Response("WebSocket upgrade failed", { status: 400 });
}

export function wsOpen(ws: ServerWebSocket<WsData>) {
  if (ws.data.mode === "logs") {
    logClients.add(ws);
    return;
  }
  const { auditId } = ws.data;
  if (!auditId) return;
  if (!clients.has(auditId)) clients.set(auditId, new Set());
  clients.get(auditId)!.add(ws);
}

export function wsClose(ws: ServerWebSocket<WsData>) {
  if (ws.data.mode === "logs") {
    logClients.delete(ws);
    return;
  }
  const { auditId } = ws.data;
  if (!auditId) return;
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

const lastSentId = new Map<string, number>();

export async function startNotifyListener() {
  const db = getDb();

  // Poll audit_events for active WebSocket subscriptions
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
          broadcastToAudit(auditId, {
            type: event.event_type,
            data: event.data,
          });
          lastSentId.set(auditId, event.id);
        }
      } catch (err) {
        console.error(`WS poll error for audit ${auditId}:`, err);
      }
    }
    // Clean up tracking for disconnected audits
    for (const auditId of lastSentId.keys()) {
      if (!clients.has(auditId)) lastSentId.delete(auditId);
    }
  }, 1000);
}

import { useEffect, useRef, useCallback, useState } from "react";

interface WsEvent {
  type: "page_analyzed" | "progress" | "completed" | "error";
  data: Record<string, any>;
}

export function useAuditWebSocket(auditId: string | undefined, enabled: boolean) {
  const wsRef = useRef<WebSocket | null>(null);
  const [events, setEvents] = useState<WsEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    if (!auditId || !enabled) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/audits/${auditId}`);
    wsRef.current = ws;

    ws.onopen = () => setIsConnected(true);
    ws.onclose = () => setIsConnected(false);
    ws.onmessage = (evt) => {
      try {
        const event: WsEvent = JSON.parse(evt.data);
        setEvents((prev) => [...prev, event]);
      } catch {}
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [auditId, enabled]);

  const clearEvents = useCallback(() => setEvents([]), []);

  return { events, isConnected, clearEvents };
}

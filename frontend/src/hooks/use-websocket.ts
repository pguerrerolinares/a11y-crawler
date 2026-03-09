import { useEffect, useRef, useCallback, useState } from "react";

interface WsEvent {
  type: "page_analyzed" | "progress" | "completed" | "error";
  data: Record<string, any>;
}

export function useAuditWebSocket(auditId: string | undefined, enabled: boolean) {
  const wsRef = useRef<WebSocket | null>(null);
  const [events, setEvents] = useState<WsEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const retriesRef = useRef(0);
  const unmountedRef = useRef(false);

  useEffect(() => {
    if (!auditId || !enabled) return;
    unmountedRef.current = false;
    retriesRef.current = 0;

    function connect() {
      if (unmountedRef.current) return;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/audits/${auditId}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        retriesRef.current = 0;
      };

      ws.onclose = () => {
        setIsConnected(false);
        wsRef.current = null;
        if (unmountedRef.current) return;
        // Reconnect with exponential backoff (max 10s)
        const delay = Math.min(1000 * 2 ** retriesRef.current, 10000);
        retriesRef.current++;
        setTimeout(connect, delay);
      };

      ws.onmessage = (evt) => {
        try {
          const event: WsEvent = JSON.parse(evt.data);
          setEvents((prev) => {
            // Deduplicate by checking if last event of same type has same data
            if (event.type === "page_analyzed") {
              const url = event.data.url;
              if (prev.some((e) => e.type === "page_analyzed" && e.data.url === url)) {
                return prev;
              }
            }
            return [...prev, event];
          });
        } catch {}
      };
    }

    connect();

    return () => {
      unmountedRef.current = true;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [auditId, enabled]);

  const clearEvents = useCallback(() => setEvents([]), []);

  return { events, isConnected, clearEvents };
}

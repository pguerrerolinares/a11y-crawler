import { useEffect, useRef, useCallback, useState } from "react";

interface WsEvent {
  type: "page_analyzed" | "progress" | "completed" | "error";
  data: Record<string, any>;
}

export function useAuditWebSocket(auditId: string | undefined, enabled: boolean) {
  const esRef = useRef<EventSource | null>(null);
  const [events, setEvents] = useState<WsEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const unmountedRef = useRef(false);

  useEffect(() => {
    if (!auditId || !enabled) return;
    unmountedRef.current = false;

    const eventSource = new EventSource(`/api/audits/${auditId}/events`);
    esRef.current = eventSource;

    eventSource.onopen = () => {
      setIsConnected(true);
    };

    eventSource.onmessage = (evt) => {
      try {
        const event: WsEvent = JSON.parse(evt.data);
        setEvents((prev) => {
          // Deduplicate page_analyzed by URL
          if (event.type === "page_analyzed") {
            const url = event.data.url;
            if (prev.some((e) => e.type === "page_analyzed" && e.data.url === url)) {
              return prev;
            }
          }
          return [...prev, event];
        });

        // Auto-close on terminal events
        if (event.type === "completed" || event.type === "error") {
          eventSource.close();
          setIsConnected(false);
        }
      } catch {}
    };

    eventSource.onerror = () => {
      if (unmountedRef.current) return;
      setIsConnected(false);
      eventSource.close();
    };

    return () => {
      unmountedRef.current = true;
      eventSource.close();
      esRef.current = null;
    };
  }, [auditId, enabled]);

  const clearEvents = useCallback(() => setEvents([]), []);

  return { events, isConnected, clearEvents };
}

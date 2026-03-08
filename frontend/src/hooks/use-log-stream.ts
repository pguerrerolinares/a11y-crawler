import { useState, useEffect, useRef, useCallback } from "react";
import type { LogEntry } from "@/lib/api";

type ConnectionStatus = "connected" | "disconnected" | "connecting";

export function useLogStream(paused = false) {
  const [liveLogs, setLiveLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bufferRef = useRef<LogEntry[]>([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Flush buffered WS messages at most twice per second to avoid continuous re-renders.
  // Skip flush while paused (e.g. detail modal is open) to prevent re-rendering the table.
  useEffect(() => {
    const interval = setInterval(() => {
      if (pausedRef.current || bufferRef.current.length === 0) return;
      const pending = bufferRef.current;
      bufferRef.current = [];
      setLiveLogs(prev => [...pending, ...prev].slice(0, 100));
    }, 500);
    return () => clearInterval(interval);
  }, []);

  const connect = useCallback(() => {
    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING
    ) return;

    setStatus("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/logs`);

    ws.onopen = () => setStatus("connected");

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "new_log" && msg.data) {
          bufferRef.current = [msg.data as LogEntry, ...bufferRef.current];
        }
      } catch (err) {
        if (import.meta.env.DEV) {
          console.warn("[useLogStream] Failed to parse WS message:", err);
        }
      }
    };

    ws.onclose = () => {
      setStatus("disconnected");
      wsRef.current = null;
      // Auto-reconnect after 3 seconds
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => ws.close();

    wsRef.current = ws;
  }, []);

  const disconnect = useCallback(() => {
    clearTimeout(reconnectTimer.current);
    wsRef.current?.close();
    wsRef.current = null;
    setStatus("disconnected");
  }, []);

  const clearLive = useCallback(() => setLiveLogs([]), []);

  useEffect(() => {
    connect();
    return disconnect;
  }, [connect, disconnect]);

  return { liveLogs, status, clearLive };
}

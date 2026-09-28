import { useCallback, useEffect, useRef, useState } from "react";
import { wsUrl } from "../lib/api";
import type { Alert, MetricsMessage, ServerMessage, Track } from "../lib/types";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

interface Options {
  onMessage?: (msg: ServerMessage) => void;
  heartbeatMs?: number;
  maxBackoffMs?: number;
}

/**
 * WebSocket con reconexión exponencial (con jitter) y heartbeat.
 * Si no llega ningún mensaje en 3 heartbeats, se fuerza la reconexión.
 */
export function useWebSocket(url: string, { onMessage, heartbeatMs = 10_000, maxBackoffMs = 15_000 }: Options = {}) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    let attempt = 0;
    let disposed = false;
    let reconnectTimer: number | undefined;
    let heartbeatTimer: number | undefined;
    let lastMessageAt = Date.now();

    const scheduleReconnect = () => {
      if (disposed) return;
      setStatus("reconnecting");
      const delay = Math.min(maxBackoffMs, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      attempt += 1;
      reconnectTimer = window.setTimeout(connect, delay);
    };

    function connect() {
      if (disposed) return;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        lastMessageAt = Date.now();
        setStatus("open");
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = window.setInterval(() => {
          if (Date.now() - lastMessageAt > heartbeatMs * 3) {
            ws.close(4000, "heartbeat timeout");
            return;
          }
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
        }, heartbeatMs);
      };

      ws.onmessage = (ev) => {
        lastMessageAt = Date.now();
        let msg: ServerMessage;
        try {
          msg = JSON.parse(ev.data as string) as ServerMessage;
        } catch {
          return;
        }
        if (msg.type === "pong" && msg.ts) setLatencyMs(Date.now() - msg.ts);
        onMessageRef.current?.(msg);
      };

      ws.onclose = () => {
        window.clearInterval(heartbeatTimer);
        if (wsRef.current === ws) wsRef.current = null;
        scheduleReconnect();
      };

      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      window.clearInterval(heartbeatTimer);
      wsRef.current?.close(1000, "unmount");
      setStatus("closed");
    };
  }, [url, heartbeatMs, maxBackoffMs]);

  const send = useCallback((data: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  }, []);

  return { status, latencyMs, send };
}

/** Estado en vivo del dashboard alimentado por /ws/metrics. */
export function useRetailStream() {
  const [metrics, setMetrics] = useState<MetricsMessage | null>(null);
  const [tracks, setTracks] = useState<{ ts: number; tracks: Track[] }>({ ts: 0, tracks: [] });
  const [liveAlerts, setLiveAlerts] = useState<Alert[]>([]);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);

  const handle = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case "metrics":
        setMetrics(msg);
        setLastUpdate(Date.now());
        break;
      case "tracks":
        setTracks({ ts: msg.ts, tracks: msg.tracks });
        break;
      case "alert":
        setLiveAlerts((prev) => [msg.alert, ...prev].slice(0, 20));
        break;
      default:
        break;
    }
  }, []);

  const { status, latencyMs } = useWebSocket(wsUrl(), { onMessage: handle });
  return { status, latencyMs, metrics, tracks, liveAlerts, lastUpdate };
}

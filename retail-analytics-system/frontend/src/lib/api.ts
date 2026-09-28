import type { Alert, HeatmapResponse, SummaryResponse } from "./types";

const BASE = import.meta.env.VITE_API_URL ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status} ${detail}`);
  }
  return (await res.json()) as T;
}

export const api = {
  heatmap: (days = 28) => request<HeatmapResponse>(`/api/metrics/heatmap?days=${days}`),
  summary: () => request<SummaryResponse>("/api/metrics/summary"),
  alerts: (hours = 24) => request<Alert[]>(`/api/alerts?hours=${hours}&limit=20`),
  ackAlert: (id: number) => request<Alert>(`/api/alerts/${id}/ack`, { method: "POST" }),
};

export const streamUrl = `${BASE}/api/stream/mjpeg`;

export function wsUrl(path = "/ws/metrics"): string {
  const explicit = import.meta.env.VITE_WS_URL as string | undefined;
  if (explicit) return explicit;
  if (BASE) return BASE.replace(/^http/, "ws") + path;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

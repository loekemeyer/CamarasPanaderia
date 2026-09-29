import { Activity, Clock3, DoorOpen, LayoutDashboard, Settings, Users, Wifi, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertsPanel } from "./components/AlertsPanel";
import { CameraFeed } from "./components/CameraFeed";
import { DemandChart } from "./components/DemandChart";
import { DwellTimeCard } from "./components/DwellTimeCard";
import { KpiTile } from "./components/KpiTile";
import { MetricGauge } from "./components/MetricGauge";
import { WeeklyHeatmap } from "./components/WeeklyHeatmap";
import { useRetailStream } from "./hooks/useWebSocket";
import { SettingsPage, type SettingsTab } from "./pages/SettingsPage";
import { api } from "./lib/api";
import { fmtClock, fmtDuration, fmtInt } from "./lib/format";
import type { Alert, HeatmapResponse, SummaryResponse } from "./lib/types";

const HEATMAP_REFRESH_MS = 5 * 60_000;
const REST_REFRESH_MS = 60_000;

type Route = { view: "panel" } | { view: "config"; tab: SettingsTab };

const TAB_KEYS: SettingsTab[] = ["camara", "zonas", "reglas", "datos"];

function parseHash(): Route {
  const m = window.location.hash.match(/^#\/configuracion(?:\/(\w+))?/);
  if (!m) return { view: "panel" };
  const tab = TAB_KEYS.includes(m[1] as SettingsTab) ? (m[1] as SettingsTab) : "camara";
  return { view: "config", tab };
}

function useHashRoute() {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((r: Route) => {
    window.location.hash = r.view === "panel" ? "/" : `/configuracion/${r.tab}`;
  }, []);
  return [route, go] as const;
}

function alertKey(a: Alert): string {
  return a.id != null ? `id:${a.id}` : `${a.kind}:${a.created_at}`;
}

function usePolling<T>(fn: () => Promise<T>, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setData(await fn());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [fn]);

  useEffect(() => {
    load();
    const id = window.setInterval(load, intervalMs);
    return () => window.clearInterval(id);
  }, [load, intervalMs]);

  return { data, error, loading, reload: load, setData };
}

const fetchHeatmap = () => api.heatmap(28);
const fetchSummary = () => api.summary();
const fetchAlerts = () => api.alerts(24);

export default function App() {
  const { status, latencyMs, metrics, tracks, liveAlerts, lastUpdate } = useRetailStream();
  const [route, go] = useHashRoute();
  const heatmap = usePolling<HeatmapResponse>(fetchHeatmap, HEATMAP_REFRESH_MS);
  const summary = usePolling<SummaryResponse>(fetchSummary, REST_REFRESH_MS);
  const restAlerts = usePolling<Alert[]>(fetchAlerts, REST_REFRESH_MS);
  const [acked, setAcked] = useState<Set<number>>(new Set());

  const alerts = useMemo(() => {
    const merged = new Map<string, Alert>();
    for (const a of [...liveAlerts, ...(metrics?.alerts ?? []), ...(restAlerts.data ?? [])]) {
      const k = alertKey(a);
      if (!merged.has(k)) merged.set(k, a);
    }
    return [...merged.values()]
      .map((a) => (a.id != null && acked.has(a.id) ? { ...a, acknowledged: true } : a))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 20);
  }, [liveAlerts, metrics?.alerts, restAlerts.data, acked]);

  const onAck = useCallback(async (id: number) => {
    setAcked((s) => new Set(s).add(id));
    try {
      await api.ackAlert(id);
    } catch {
      setAcked((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  }, []);

  const score = metrics?.accumulation.score ?? 0;
  const level = metrics?.accumulation.level ?? "fluido";
  const connected = status === "open";

  return (
    <div className="mx-auto max-w-[1600px] px-4 pb-8 pt-5 sm:px-6">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-accent-strong shadow-glow">
            <Activity className="h-5 w-5 text-white" aria-hidden />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-50">
              Retail Analytics <span className="text-accent">·</span> Centro de control
            </h1>
            <p className="text-xs text-zinc-500">
              {metrics?.camera_name ?? "Cámara"} · {metrics?.camera_id ?? "—"} · analítica de video en tiempo real
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <nav className="mr-1 flex rounded-lg border border-white/10 bg-white/[0.02] p-0.5" aria-label="Principal">
            {(
              [
                ["panel", "Panel", LayoutDashboard],
                ["config", "Configuración", Settings],
              ] as const
            ).map(([view, label, Icon]) => (
              <button
                key={view}
                type="button"
                onClick={() => go(view === "panel" ? { view } : { view, tab: "camara" })}
                aria-current={route.view === view ? "page" : undefined}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${route.view === view ? "bg-white/[0.08] text-zinc-50" : "text-zinc-400 hover:text-zinc-200"}`}
              >
                <Icon className={`h-3.5 w-3.5 ${route.view === view ? "text-accent" : ""}`} aria-hidden />
                {label}
              </button>
            ))}
          </nav>
          <span className={`chip ${connected ? "" : "border-status-warning/40 text-status-warning"}`}>
            {connected ? <Wifi className="h-3.5 w-3.5 text-status-good" aria-hidden /> : <WifiOff className="h-3.5 w-3.5" aria-hidden />}
            {connected ? "Conectado" : status === "reconnecting" ? "Reconectando…" : "Conectando…"}
            {connected && latencyMs != null && <span className="text-zinc-500">· {latencyMs} ms</span>}
          </span>
          <span className="chip">
            <Clock3 className="h-3.5 w-3.5 text-zinc-500" aria-hidden />
            {lastUpdate ? `Actualizado ${fmtClock(lastUpdate)}` : "Esperando datos"}
          </span>
        </div>
      </header>

      {route.view === "config" ? (
        <SettingsPage tab={route.tab} onTab={(tab) => go({ view: "config", tab })} frameSize={metrics?.frame_size ?? null} />
      ) : (
      <main className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="lg:col-span-8 lg:row-span-2">
          <CameraFeed
            cameraName={metrics?.camera_name ?? "Cámara"}
            sourceMode={metrics?.source_mode ?? "starting"}
            hasVideo={metrics?.has_video ?? false}
            streamConnected={metrics?.stream_connected ?? false}
            frameSize={metrics?.frame_size ?? null}
            processingFps={metrics?.processing_fps ?? 0}
            tracks={tracks.tracks}
            tracksTs={tracks.ts}
            zones={metrics?.zones ?? []}
            peopleCount={metrics?.people_count ?? 0}
            queueLength={metrics?.queue_length ?? 0}
          />
        </div>

        <div className="lg:col-span-4">
          <MetricGauge
            score={score}
            level={level}
            queueLength={metrics?.queue_length ?? 0}
            queueCapacity={metrics?.queue_capacity ?? 0}
            avgWaitSeconds={metrics?.avg_queue_wait_seconds ?? 0}
            maxWaitSeconds={metrics?.max_queue_wait_seconds ?? 0}
          />
        </div>

        <div className="grid grid-cols-2 gap-4 lg:col-span-4">
          <KpiTile
            label="Personas ahora"
            value={fmtInt(metrics?.people_count ?? 0)}
            icon={Users}
            sub={summary.data ? `Pico del día: ${fmtInt(summary.data.peak_people)}` : "En cuadro"}
          />
          <KpiTile
            label="En fila"
            value={fmtInt(metrics?.queue_length ?? 0)}
            unit={`/ ${fmtInt(metrics?.queue_capacity ?? 0)}`}
            icon={Activity}
            emphasis={level === "alto" || level === "critico"}
            sub={summary.data ? `Pico del día: ${fmtInt(summary.data.peak_queue)}` : "Zona de caja"}
          />
          <KpiTile
            label="Ingresos hoy"
            value={fmtInt(metrics?.today.entries ?? 0)}
            icon={DoorOpen}
            sub={`${fmtInt(metrics?.today.exits ?? 0)} finalizados`}
          />
          <KpiTile
            label="Permanencia"
            value={fmtDuration(metrics?.dwell.avg_seconds)}
            icon={Clock3}
            sub="Promedio del día"
          />
        </div>

        <div className="lg:col-span-8">
          <DemandChart
            hourly={metrics?.hourly ?? []}
            entriesToday={metrics?.today.entries ?? 0}
            exitsToday={metrics?.today.exits ?? 0}
            peopleNow={metrics?.people_count ?? 0}
          />
        </div>
        <div className="lg:col-span-4">
          <DwellTimeCard dwell={metrics?.dwell ?? null} />
        </div>

        <div className="lg:col-span-8">
          <WeeklyHeatmap data={heatmap.data} loading={heatmap.loading} error={heatmap.error} />
        </div>
        <div className="lg:col-span-4">
          <AlertsPanel alerts={alerts} onAck={onAck} summary={summary.data} />
        </div>
      </main>
      )}
    </div>
  );
}

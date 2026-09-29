import { AlertOctagon, AlertTriangle, BellRing, Check, Info } from "lucide-react";
import { fmtInt, fmtRelative } from "../lib/format";
import type { Alert, SummaryResponse } from "../lib/types";
import { Card } from "./Card";

interface AlertsPanelProps {
  alerts: Alert[];
  onAck: (id: number) => void;
  summary: SummaryResponse | null;
}

const SEVERITY = {
  critical: { label: "Crítica", Icon: AlertOctagon, cls: "text-status-critical border-status-critical/30 bg-status-critical/10" },
  high: { label: "Alta", Icon: AlertTriangle, cls: "text-status-serious border-status-serious/30 bg-status-serious/10" },
  medium: { label: "Media", Icon: Info, cls: "text-status-warning border-status-warning/30 bg-status-warning/10" },
  low: { label: "Baja", Icon: Info, cls: "text-zinc-300 border-white/10 bg-white/5" },
} as const;

export function AlertsPanel({ alerts, onAck, summary }: AlertsPanelProps) {
  const open = alerts.filter((a) => !a.acknowledged).length;
  return (
    <Card
      title="Alertas operativas"
      subtitle="Últimas 24 h"
      className="h-full"
      bodyClassName="flex min-h-0 flex-col gap-4"
      actions={
        <span className={`chip ${open ? "border-accent/40 text-accent-soft" : ""}`}>
          <BellRing className="h-3.5 w-3.5" aria-hidden /> {open} abiertas
        </span>
      }
    >
      <ul className={`flex flex-1 ${alerts.length ? "max-h-[300px]" : ""} flex-col gap-2 overflow-y-auto pr-1`}>
        {alerts.length === 0 && (
          <li className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-white/10 px-3 py-6 text-center text-sm text-zinc-500">
            Sin alertas. La operación está fluida.
          </li>
        )}
        {alerts.map((a, i) => {
          const sev = SEVERITY[a.severity as keyof typeof SEVERITY] ?? SEVERITY.low;
          return (
            <li
              key={a.id ?? `${a.created_at}-${i}`}
              className={`rounded-xl border border-white/5 bg-black/20 p-3 ${a.acknowledged ? "opacity-50" : ""}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2">
                  <span className={`mt-0.5 inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${sev.cls}`}>
                    <sev.Icon className="h-3 w-3" aria-hidden />
                    {sev.label}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-zinc-100">{a.title}</p>
                    <p className="mt-0.5 text-xs text-zinc-400">{a.message}</p>
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="text-[10px] text-zinc-500">{fmtRelative(a.created_at)}</span>
                  {!a.acknowledged && a.id != null && (
                    <button
                      type="button"
                      onClick={() => onAck(a.id!)}
                      className="inline-flex items-center gap-1 rounded-md border border-white/10 px-1.5 py-0.5 text-[10px] text-zinc-300 transition hover:border-accent/50 hover:text-zinc-50"
                    >
                      <Check className="h-3 w-3" aria-hidden /> Visto
                    </button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <dl className="grid grid-cols-3 divide-x divide-white/5 rounded-xl border border-white/5 bg-black/20 text-center">
        {[
          ["Alertas hoy", fmtInt(summary?.alerts)],
          ["Índice máx.", summary?.max_accumulation == null ? "—" : fmtInt(summary.max_accumulation)],
          ["Índice prom.", summary?.avg_accumulation == null ? "—" : fmtInt(summary.avg_accumulation)],
        ].map(([k, v]) => (
          <div key={k} className="px-2 py-2.5">
            <dt className="label">{k}</dt>
            <dd className="mt-1 text-lg font-light tabular-nums tracking-tight text-zinc-50">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

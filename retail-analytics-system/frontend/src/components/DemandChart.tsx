import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from "recharts";
import { fmtInt } from "../lib/format";
import type { HourlyBucket } from "../lib/types";
import { Card } from "./Card";

interface DemandChartProps {
  hourly: HourlyBucket[];
  entriesToday: number;
  exitsToday: number;
  peopleNow: number;
}

const SERIES = [
  { key: "entries", label: "Ingresos", color: "#f43f5e" },
  { key: "exits", label: "Finalizaciones", color: "#6366f1" },
] as const;

const OPEN_FROM = 6;
const OPEN_TO = 22;

function ChartTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  const entries = Number(payload.find((p) => p.dataKey === "entries")?.value ?? 0);
  const exits = Number(payload.find((p) => p.dataKey === "exits")?.value ?? 0);
  return (
    <div className="rounded-lg border border-white/10 bg-zinc-950/95 px-3 py-2 text-xs shadow-xl">
      <div className="mb-1 font-semibold text-zinc-100">{label} h</div>
      {SERIES.map((s) => (
        <div key={s.key} className="flex items-center justify-between gap-6 text-zinc-300">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} aria-hidden />
            {s.label}
          </span>
          <span className="font-semibold tabular-nums text-zinc-100">{fmtInt(s.key === "entries" ? entries : exits)}</span>
        </div>
      ))}
      <div className="mt-1 border-t border-white/5 pt-1 text-zinc-500">
        Saldo {entries - exits >= 0 ? "+" : ""}
        {fmtInt(entries - exits)}
      </div>
    </div>
  );
}

export function DemandChart({ hourly, entriesToday, exitsToday, peopleNow }: DemandChartProps) {
  const currentHour = new Date().getHours();

  const data = useMemo(() => {
    const withData = hourly.filter((h) => h.entries > 0 || h.exits > 0).map((h) => h.hour);
    const from = Math.min(OPEN_FROM, ...withData);
    const to = Math.max(OPEN_TO, currentHour, ...withData);
    return hourly.filter((h) => h.hour >= from && h.hour <= to).map((h) => ({ ...h, label: String(h.hour).padStart(2, "0") }));
  }, [hourly, currentHour]);

  const peak = useMemo(() => data.reduce((best, d) => (d.entries > best.entries ? d : best), data[0] ?? { entries: 0, label: "—" }), [data]);

  return (
    <Card
      title="Volumen por hora: demanda y atención"
      subtitle="Ingresos detectados vs. finalizaciones estimadas (salidas) · personas/hora, hoy"
      actions={
        <div className="flex items-center gap-3" role="list" aria-label="Leyenda">
          {SERIES.map((s) => (
            <span key={s.key} role="listitem" className="flex items-center gap-1.5 text-xs text-zinc-400">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
              {s.label}
            </span>
          ))}
        </div>
      }
    >
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Ingresos hoy", fmtInt(entriesToday)],
          ["Finalizaciones", fmtInt(exitsToday)],
          ["En el local", fmtInt(peopleNow)],
          ["Hora pico", peak && peak.entries > 0 ? `${peak.label}:00 · ${fmtInt(peak.entries)}` : "—"],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg border border-white/5 bg-black/20 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">{k}</div>
            <div className="text-lg font-semibold tabular-nums text-zinc-100">{v}</div>
          </div>
        ))}
      </div>
      <div className="h-[230px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} barGap={2} barCategoryGap="22%" margin={{ top: 8, right: 4, left: -18, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.05)" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={{ stroke: "rgba(255,255,255,0.08)" }}
              tick={{ fill: "#71717a", fontSize: 11 }}
              interval={0}
            />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: "#71717a", fontSize: 11 }} width={40} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
            <ReferenceLine
              x={String(currentHour).padStart(2, "0")}
              stroke="rgba(244,63,94,0.45)"
              strokeDasharray="3 3"
              label={{ value: "ahora", position: "insideTopRight", fill: "#a1a1aa", fontSize: 10 }}
            />
            {SERIES.map((s) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

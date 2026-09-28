import { Clock } from "lucide-react";
import { useState } from "react";
import { fmtDurationShort, fmtInt, fmtPct } from "../lib/format";
import type { DwellStats } from "../lib/types";
import { Card } from "./Card";

interface DwellTimeCardProps {
  dwell: DwellStats | null;
}

// Rampa secuencial de un solo tono (más oscuro = más permanencia).
const COLORS: Record<string, string> = {
  lt3: "#fda4af",
  b3_6: "#fb7185",
  b6_10: "#e11d48",
  gt10: "#9f1239",
};

const SIZE = 150;
const STROKE = 18;
const RADIUS = (SIZE - STROKE) / 2;
const CIRC = 2 * Math.PI * RADIUS;
const GAP = 3; // px de separación entre segmentos

export function DwellTimeCard({ dwell }: DwellTimeCardProps) {
  const [hover, setHover] = useState<string | null>(null);
  const buckets = dwell?.buckets ?? [];
  const total = dwell?.total_visits ?? 0;

  let offset = 0;
  const segments = buckets.map((b) => {
    const len = total ? (b.count / total) * CIRC : 0;
    const seg = { ...b, len: Math.max(len - GAP, 0), offset };
    offset += len;
    return seg;
  });

  const active = hover ? buckets.find((b) => b.key === hover) : null;

  return (
    <Card title="Tiempo de permanencia" subtitle={`Visitas finalizadas hoy · ${fmtInt(total)} clientes`}>
      <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center lg:flex-col xl:flex-row">
        <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
          <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="-rotate-90" role="img" aria-label="Distribución de permanencia">
            <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} stroke="#27272a" strokeWidth={STROKE} fill="none" />
            {segments.map((s) =>
              s.len > 0 ? (
                <circle
                  key={s.key}
                  cx={SIZE / 2}
                  cy={SIZE / 2}
                  r={RADIUS}
                  fill="none"
                  stroke={COLORS[s.key]}
                  strokeWidth={hover === s.key ? STROKE + 4 : STROKE}
                  strokeDasharray={`${s.len} ${CIRC - s.len}`}
                  strokeDashoffset={-s.offset}
                  opacity={hover && hover !== s.key ? 0.35 : 1}
                  onMouseEnter={() => setHover(s.key)}
                  onMouseLeave={() => setHover(null)}
                  style={{ transition: "stroke-dasharray 500ms ease, opacity 150ms" }}
                >
                  <title>{`${s.label}: ${fmtPct(s.percentage)} (${fmtInt(s.count)})`}</title>
                </circle>
              ) : null,
            )}
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            {active ? (
              <>
                <span className="text-2xl font-semibold tabular-nums text-zinc-50">{fmtPct(active.percentage)}</span>
                <span className="text-[11px] text-zinc-500">{active.label}</span>
              </>
            ) : (
              <>
                <Clock className="mb-0.5 h-4 w-4 text-accent" aria-hidden />
                <span className="text-lg font-semibold tabular-nums text-zinc-50">{fmtDurationShort(dwell?.avg_seconds)}</span>
                <span className="text-[11px] text-zinc-500">promedio</span>
              </>
            )}
          </div>
        </div>

        <ul className="w-full space-y-2.5">
          {buckets.map((b) => (
            <li
              key={b.key}
              onMouseEnter={() => setHover(b.key)}
              onMouseLeave={() => setHover(null)}
              className={`rounded-lg px-2 py-1.5 transition ${hover === b.key ? "bg-white/[0.04]" : ""}`}
            >
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 text-zinc-300">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: COLORS[b.key] }} aria-hidden />
                  {b.label}
                </span>
                <span className="tabular-nums">
                  <span className="font-semibold text-zinc-100">{fmtPct(b.percentage)}</span>
                  <span className="ml-2 text-xs text-zinc-500">{fmtInt(b.count)}</span>
                </span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${b.percentage}%`, background: COLORS[b.key], transition: "width 500ms ease" }}
                />
              </div>
            </li>
          ))}
          {!buckets.length && <li className="text-sm text-zinc-500">Sin visitas finalizadas todavía.</li>}
        </ul>
      </div>
    </Card>
  );
}

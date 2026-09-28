import { useMemo, useState } from "react";
import { fmtDec1, fmtInt } from "../lib/format";
import type { HeatmapCell, HeatmapResponse } from "../lib/types";
import { Card } from "./Card";

interface WeeklyHeatmapProps {
  data: HeatmapResponse | null;
  loading: boolean;
  error: string | null;
}

const DAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const LOW = [39, 39, 42]; // zinc-800
const HIGH = [244, 63, 94]; // rose-500

function cellColor(intensity: number): string {
  const t = Math.max(0, Math.min(1, intensity / 100));
  const k = t ** 0.8;
  const c = LOW.map((lo, i) => Math.round(lo + (HIGH[i] - lo) * k));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

export function WeeklyHeatmap({ data, loading, error }: WeeklyHeatmapProps) {
  const [hover, setHover] = useState<HeatmapCell | null>(null);
  const now = new Date();
  const nowDow = ((now.getDay() + 6) % 7) + 1;
  const nowHour = now.getHours();

  const { hours, grid, peaks } = useMemo(() => {
    const cells = data?.cells ?? [];
    const active = cells.filter((c) => c.avg_entries > 0).map((c) => c.hour);
    const from = active.length ? Math.min(...active) : 6;
    const to = active.length ? Math.max(...active) : 22;
    const hrs = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    const g = new Map(cells.map((c) => [`${c.dow}-${c.hour}`, c]));
    const top = [...cells].sort((a, b) => b.avg_entries - a.avg_entries).slice(0, 3).filter((c) => c.avg_entries > 0);
    return { hours: hrs, grid: g, peaks: top };
  }, [data]);

  return (
    <Card
      title="Exigencia horaria semanal"
      subtitle={`Ingresos promedio por hora · últimos ${data?.days ?? 28} días`}
      actions={
        <div className="flex items-center gap-2 text-[11px] text-zinc-500">
          <span>0</span>
          <span className="h-2 w-24 rounded-full" style={{ background: `linear-gradient(90deg, ${cellColor(0)}, ${cellColor(50)}, ${cellColor(100)})` }} />
          <span>{fmtDec1(data?.max_avg_entries ?? 0)} /h</span>
        </div>
      }
    >
      {error && <p className="text-sm text-status-critical">No se pudo cargar el historial: {error}</p>}
      {loading && !data && <div className="h-52 animate-pulse rounded-xl bg-white/[0.03]" />}
      {data && (
        <div className="flex flex-col gap-4">
          <div className="overflow-x-auto">
            <table className="w-full border-separate" style={{ borderSpacing: 2 }}>
              <thead>
                <tr>
                  <th className="w-9" />
                  {hours.map((h) => (
                    <th key={h} scope="col" className={`text-center text-[10px] font-medium ${h === nowHour ? "text-accent" : "text-zinc-500"}`}>
                      {String(h).padStart(2, "0")}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DAYS.map((d, i) => {
                  const dow = i + 1;
                  return (
                    <tr key={d}>
                      <th scope="row" className={`pr-1 text-left text-[11px] font-medium ${dow === nowDow ? "text-accent" : "text-zinc-400"}`}>
                        {d}
                      </th>
                      {hours.map((h) => {
                        const c = grid.get(`${dow}-${h}`);
                        const isNow = dow === nowDow && h === nowHour;
                        return (
                          <td
                            key={h}
                            onMouseEnter={() => c && setHover(c)}
                            onMouseLeave={() => setHover(null)}
                            className={`h-7 min-w-[22px] cursor-default rounded-[4px] transition-transform hover:scale-110 ${isNow ? "ring-2 ring-zinc-100" : ""}`}
                            style={{ background: cellColor(c?.intensity ?? 0) }}
                            aria-label={`${d} ${h}:00 — ${fmtDec1(c?.avg_entries ?? 0)} ingresos promedio`}
                          />
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/5 pt-3 text-xs">
            <div className="min-h-[20px] text-zinc-400">
              {hover ? (
                <>
                  <span className="font-semibold text-zinc-100">
                    {DAYS[hover.dow - 1]} {String(hover.hour).padStart(2, "0")}:00
                  </span>{" "}
                  · {fmtDec1(hover.avg_entries)} ingresos/h · {fmtDec1(hover.avg_people)} personas prom. · índice{" "}
                  {fmtInt(hover.avg_accumulation)}/100
                </>
              ) : (
                <span className="text-zinc-500">Pasá el cursor sobre una celda para ver el detalle.</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-zinc-500">Picos:</span>
              {peaks.map((p) => (
                <span key={`${p.dow}-${p.hour}`} className="chip">
                  {DAYS[p.dow - 1]} {String(p.hour).padStart(2, "0")}h · {fmtDec1(p.avg_entries)}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

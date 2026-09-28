import { AlertOctagon, AlertTriangle, CheckCircle2, Gauge } from "lucide-react";
import type { AccumulationLevel } from "../lib/types";
import { fmtDuration, fmtInt } from "../lib/format";
import { Card } from "./Card";

interface MetricGaugeProps {
  score: number;
  level: AccumulationLevel;
  queueLength: number;
  queueCapacity: number;
  avgWaitSeconds: number;
  maxWaitSeconds: number;
}

const LEVELS: Record<AccumulationLevel, { label: string; color: string; text: string; Icon: typeof Gauge }> = {
  fluido: { label: "Fluidez óptima", color: "#10b981", text: "text-status-good", Icon: CheckCircle2 },
  moderado: { label: "Acumulación moderada", color: "#f59e0b", text: "text-status-warning", Icon: Gauge },
  alto: { label: "Acumulación alta", color: "#f97316", text: "text-status-serious", Icon: AlertTriangle },
  critico: { label: "Acumulación crítica", color: "#ef4444", text: "text-status-critical", Icon: AlertOctagon },
};

const START = 150; // grados
const SWEEP = 240;
const R = 80;
const CX = 100;
const CY = 100;

function polar(deg: number, r = R) {
  const rad = (deg * Math.PI) / 180;
  return { x: CX + r * Math.cos(rad), y: CY + r * Math.sin(rad) };
}

function arc(fromDeg: number, toDeg: number, r = R) {
  const a = polar(fromDeg, r);
  const b = polar(toDeg, r);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${large} 1 ${b.x} ${b.y}`;
}

export function MetricGauge({
  score,
  level,
  queueLength,
  queueCapacity,
  avgWaitSeconds,
  maxWaitSeconds,
}: MetricGaugeProps) {
  const s = Math.max(0, Math.min(100, score));
  const end = START + (SWEEP * s) / 100;
  const meta = LEVELS[level];
  const tip = polar(end);
  const thresholds = [35, 60, 80];

  return (
    <Card title="Acumulación / Fluidez" subtitle="Índice compuesto de fila, espera y ocupación">
      <div className="flex flex-col items-center">
        <svg viewBox="0 0 200 172" className="w-full max-w-[260px]" role="img" aria-label={`${Math.round(s)} de 100 puntos, ${meta.label}`}>
          <defs>
            <linearGradient id="gauge-grad" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0%" stopColor="#fda4af" />
              <stop offset="55%" stopColor="#f43f5e" />
              <stop offset="100%" stopColor="#be123c" />
            </linearGradient>
            <filter id="gauge-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="3" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <path d={arc(START, START + SWEEP)} stroke="#27272a" strokeWidth="14" fill="none" strokeLinecap="round" />
          {Array.from({ length: 21 }, (_, i) => {
            const deg = START + (SWEEP * i) / 20;
            const a = polar(deg, R - 14);
            const b = polar(deg, R - (i % 5 === 0 ? 22 : 18));
            return (
              <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={i % 5 === 0 ? "#52525b" : "#3f3f46"} strokeWidth={1} />
            );
          })}
          {thresholds.map((t) => {
            const deg = START + (SWEEP * t) / 100;
            const a = polar(deg, R + 9);
            const b = polar(deg, R + 4);
            return <line key={t} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#71717a" strokeWidth={1.5} />;
          })}
          {s > 0.5 && (
            <path
              d={arc(START, end)}
              stroke="url(#gauge-grad)"
              strokeWidth="14"
              fill="none"
              strokeLinecap="round"
              filter="url(#gauge-glow)"
              style={{ transition: "d 600ms ease" }}
            />
          )}
          <circle cx={tip.x} cy={tip.y} r="6" fill="#18181b" stroke="#fafafa" strokeWidth="2" />
          <text x={CX} y={CY + 4} textAnchor="middle" className="fill-zinc-50" style={{ font: "600 44px Inter, sans-serif" }}>
            {Math.round(s)}
          </text>
          <text x={CX} y={CY + 24} textAnchor="middle" className="fill-zinc-500" style={{ font: "500 11px Inter, sans-serif" }}>
            de 100 puntos
          </text>
          <text x={polar(START, R).x} y={158} textAnchor="middle" className="fill-zinc-500" style={{ font: "500 10px Inter" }}>
            0
          </text>
          <text x={polar(START + SWEEP, R).x} y={158} textAnchor="middle" className="fill-zinc-500" style={{ font: "500 10px Inter" }}>
            100
          </text>
        </svg>

        <div className={`-mt-2 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-sm font-medium ${meta.text}`}>
          <meta.Icon className="h-4 w-4" aria-hidden />
          <span className="text-zinc-100">{meta.label}</span>
        </div>

        <dl className="mt-4 grid w-full grid-cols-3 divide-x divide-white/5 rounded-xl border border-white/5 bg-black/20 text-center">
          <div className="px-2 py-2.5">
            <dt className="text-[10px] uppercase tracking-wider text-zinc-500">En fila</dt>
            <dd className="mt-0.5 text-base font-semibold tabular-nums text-zinc-100">
              {fmtInt(queueLength)}
              <span className="text-xs font-normal text-zinc-500"> / {fmtInt(queueCapacity)}</span>
            </dd>
          </div>
          <div className="px-2 py-2.5">
            <dt className="text-[10px] uppercase tracking-wider text-zinc-500">Espera prom.</dt>
            <dd className="mt-0.5 text-base font-semibold tabular-nums text-zinc-100">{fmtDuration(avgWaitSeconds)}</dd>
          </div>
          <div className="px-2 py-2.5">
            <dt className="text-[10px] uppercase tracking-wider text-zinc-500">Espera máx.</dt>
            <dd className="mt-0.5 text-base font-semibold tabular-nums text-zinc-100">{fmtDuration(maxWaitSeconds)}</dd>
          </div>
        </dl>
      </div>
    </Card>
  );
}

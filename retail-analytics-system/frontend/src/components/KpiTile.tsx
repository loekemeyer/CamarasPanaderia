import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface KpiTileProps {
  label: string;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  icon: LucideIcon;
  emphasis?: boolean;
}

export function KpiTile({ label, value, unit, sub, icon: Icon, emphasis = false }: KpiTileProps) {
  return (
    <div className={`card flex flex-col justify-between p-4 ${emphasis ? "shadow-glow ring-1 ring-accent/30" : ""}`}>
      <div className="flex items-center justify-between">
        <span className="label text-zinc-400">{label}</span>
        <Icon className={`h-4 w-4 ${emphasis ? "text-accent" : "text-zinc-500"}`} aria-hidden />
      </div>
      <div className="mt-3 flex items-baseline gap-1.5">
        <span className="figure text-[32px] leading-none">{value}</span>
        {unit && <span className="text-sm text-zinc-500">{unit}</span>}
      </div>
      {sub && <div className="mt-1 text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

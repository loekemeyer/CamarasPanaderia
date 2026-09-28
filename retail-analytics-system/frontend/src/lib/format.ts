const LOCALE = "es-AR";

const intFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const dec1Fmt = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const fmtInt = (n: number | null | undefined): string => (n == null ? "—" : intFmt.format(n));
export const fmtDec1 = (n: number | null | undefined): string => (n == null ? "—" : dec1Fmt.format(n));
export const fmtPct = (n: number | null | undefined): string => (n == null ? "—" : `${dec1Fmt.format(n)} %`);

export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m} min ${rest} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

export function fmtClock(ms: number, withSeconds = true): string {
  return new Date(ms).toLocaleTimeString(LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
  });
}

export function fmtRelative(iso: string, now = Date.now()): string {
  const diff = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "hace instantes";
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
  return new Date(iso).toLocaleDateString(LOCALE, { day: "2-digit", month: "short" });
}

/** Formato compacto para espacios reducidos: 4:21 min, 45 s, 1:05 h. */
export function fmtDurationShort(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${String(s % 60).padStart(2, "0")} min`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")} h`;
}

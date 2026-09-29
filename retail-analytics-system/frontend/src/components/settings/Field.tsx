import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="label text-zinc-400">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs leading-relaxed text-zinc-500">{hint}</p>}
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/20 disabled:opacity-50";

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputCls} ${props.className ?? ""}`} />;
}

export function NumberInput({
  unit,
  value,
  onValue,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & { unit?: string; value: number; onValue: (n: number) => void }) {
  return (
    <div className="relative">
      <input
        {...rest}
        type="number"
        inputMode="decimal"
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onValue(e.target.value === "" ? NaN : Number(e.target.value))}
        className={`${inputCls} tabular-nums ${unit ? "pr-14" : ""}`}
      />
      {unit && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[11px] text-zinc-500">{unit}</span>}
    </div>
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputCls} appearance-none bg-[length:12px] pr-8 ${props.className ?? ""}`} />;
}

type Variant = "primary" | "ghost" | "danger";
const variants: Record<Variant, string> = {
  primary: "bg-accent-strong text-white hover:bg-accent shadow-glow",
  ghost: "border border-white/10 bg-white/[0.03] text-zinc-200 hover:border-white/20 hover:bg-white/[0.06]",
  danger: "border border-status-critical/40 bg-status-critical/10 text-red-200 hover:bg-status-critical/20",
};

export function Button({
  variant = "ghost",
  busy = false,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${rest.className ?? ""}`}
    >
      {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export type Notice = { kind: "ok" | "error"; text: string } | null;

export function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  const ok = notice.kind === "ok";
  return (
    <p role="status" className={`flex items-center gap-1.5 text-sm ${ok ? "text-status-good" : "text-red-300"}`}>
      {ok ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <AlertCircle className="h-4 w-4" aria-hidden />}
      {notice.text}
    </p>
  );
}

export function Section({ title, description, children, aside }: { title: string; description?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="card p-5">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="card-title">{title}</h3>
          {description && <p className="mt-1 max-w-2xl text-sm text-zinc-500">{description}</p>}
        </div>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

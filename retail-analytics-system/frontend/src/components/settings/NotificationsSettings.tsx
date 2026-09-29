import { BellRing, ExternalLink, MessageCircle, Send } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { NotificationSettings as Cfg } from "../../lib/types";
import { Button, Field, NoticeLine, Section, Select, TextInput, errorText, type Notice } from "./Field";

type Chat = { id: string; title: string; type: string };

const SEVERITIES: { value: Cfg["notify_min_severity"]; label: string }[] = [
  { value: "critical", label: "Sólo críticas (caja sin atender, acumulación extrema)" },
  { value: "high", label: "Altas y críticas (recomendado)" },
  { value: "medium", label: "Todas, incluida espera prolongada" },
];

export function NotificationsSettings({ onAuthError }: { onAuthError: (e: unknown) => boolean }) {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [bot, setBot] = useState<string | null>(null);
  const [busy, setBusy] = useState<"detect" | "test" | "save" | "summary" | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [noticeAt, setNoticeAt] = useState<"steps" | "save">("steps");
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    api.notifications().then(setCfg).catch((e) => setNotice({ kind: "error", text: errorText(e) }));
  }, []);

  if (!cfg) return <div className="card h-64 animate-pulse" />;

  const set = <K extends keyof Cfg>(k: K, v: Cfg[K]) => setCfg({ ...cfg, [k]: v });

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    setBusy(kind);
    setNotice(null);
    setNoticeAt(kind === "save" ? "save" : "steps");
    try {
      await fn();
    } catch (e) {
      if (!onAuthError(e)) setNotice({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const detect = () =>
    run("detect", async () => {
      const r = await api.detectTelegram(cfg.telegram_bot_token);
      setBot(r.bot.username);
      setChats(r.chats);
      if (r.chats.length === 1) set("telegram_chat_id", r.chats[0].id);
      setNotice(
        r.chats.length
          ? { kind: "ok", text: `Bot @${r.bot.username} conectado. ${r.chats.length === 1 ? "Chat detectado." : "Elegí el chat."}` }
          : { kind: "error", text: `Bot @${r.bot.username} conectado, pero nadie le escribió todavía. Mandale "hola" y volvé a tocar Detectar.` },
      );
    });

  const test = () =>
    run("test", async () => {
      await api.testTelegram(cfg.telegram_bot_token, cfg.telegram_chat_id);
      setNotice({ kind: "ok", text: "Mensaje de prueba enviado. Revisá Telegram." });
    });

  const save = () =>
    run("save", async () => {
      const { status: _status, ...body } = cfg;
      void _status;
      setCfg(await api.saveNotifications(body));
      setNotice({ kind: "ok", text: cfg.telegram_enabled ? "Guardado. Los avisos quedan activos." : "Guardado (avisos desactivados)." });
    });

  const summary = () =>
    run("summary", async () => {
      const r = await api.summaryNow();
      setPreview(r.text);
      setNotice({ kind: "ok", text: "Resumen de hoy enviado." });
    });

  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex flex-col gap-4">
        <Section
          title="Telegram"
          description="Gratis. Las alertas llegan al celular del dueño o a un grupo del personal, aunque estén fuera del local."
          aside={
            <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" className="accent-rose-500" checked={cfg.telegram_enabled} onChange={(e) => set("telegram_enabled", e.target.checked)} />
              Avisos activos
            </label>
          }
        >
          <ol className="flex flex-col gap-5">
            <li className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-accent/60 font-mono text-[11px] text-accent">1</span>
              <div className="flex flex-1 flex-col gap-2">
                <p className="text-sm text-zinc-300">
                  En Telegram, abrí{" "}
                  <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                    @BotFather <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                  , escribí <code className="rounded bg-white/5 px-1 font-mono text-[12px]">/newbot</code>, poné un nombre (por ejemplo "Panadería Avisos") y copiá el token que te da.
                </p>
                <Field label="Token del bot" htmlFor="tk">
                  <TextInput
                    id="tk"
                    className="font-mono text-[13px]"
                    autoComplete="off"
                    placeholder="123456789:AA…"
                    value={cfg.telegram_bot_token}
                    onChange={(e) => set("telegram_bot_token", e.target.value)}
                  />
                </Field>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-accent/60 font-mono text-[11px] text-accent">2</span>
              <div className="flex flex-1 flex-col gap-2">
                <p className="text-sm text-zinc-300">
                  Escribile "hola" al bot{bot ? ` (@${bot})` : ""} desde el celular que va a recibir los avisos, o agregalo a un grupo. Después tocá <b className="font-medium text-zinc-100">Detectar chat</b>.
                </p>
                <div className="flex flex-wrap items-end gap-3">
                  <Button onClick={detect} busy={busy === "detect"} disabled={!cfg.telegram_bot_token}>
                    <MessageCircle className="h-4 w-4" aria-hidden /> Detectar chat
                  </Button>
                  {chats.length > 1 && (
                    <div className="min-w-[220px] flex-1">
                      <Select value={cfg.telegram_chat_id} onChange={(e) => set("telegram_chat_id", e.target.value)} aria-label="Chat">
                        <option value="">Elegí un chat…</option>
                        {chats.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.title} ({c.type === "private" ? "privado" : "grupo"})
                          </option>
                        ))}
                      </Select>
                    </div>
                  )}
                  {cfg.telegram_chat_id && <span className="font-mono text-[11px] text-zinc-500">chat {cfg.telegram_chat_id}</span>}
                </div>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-accent/60 font-mono text-[11px] text-accent">3</span>
              <div className="flex flex-1 flex-wrap items-center gap-3">
                <Button onClick={test} busy={busy === "test"} disabled={!cfg.telegram_bot_token || !cfg.telegram_chat_id}>
                  <Send className="h-4 w-4" aria-hidden /> Enviar prueba
                </Button>
                <span className="text-xs text-zinc-500">Confirmá que el mensaje llega antes de guardar.</span>
              </div>
            </li>
          </ol>
          {noticeAt === "steps" && notice && (
            <div className="mt-4 border-t border-white/5 pt-3">
              <NoticeLine notice={notice} />
            </div>
          )}
        </Section>

        <Section title="Qué avisar">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Alertas en el momento" htmlFor="sev">
              <Select id="sev" value={cfg.notify_min_severity} onChange={(e) => set("notify_min_severity", e.target.value as Cfg["notify_min_severity"])}>
                {SEVERITIES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Resumen del día" htmlFor="hour" hint="Ingresos, hora pico, fila máxima, abandonos y permanencia.">
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 whitespace-nowrap text-sm text-zinc-300">
                  <input type="checkbox" className="accent-rose-500" checked={cfg.daily_summary_enabled} onChange={(e) => set("daily_summary_enabled", e.target.checked)} />
                  Enviar a las
                </label>
                <Select id="hour" className="w-28" value={cfg.daily_summary_hour} onChange={(e) => set("daily_summary_hour", Number(e.target.value))} disabled={!cfg.daily_summary_enabled}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, "0")}:00
                    </option>
                  ))}
                </Select>
              </div>
            </Field>
          </div>
        </Section>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={save} busy={busy === "save"}>
            Guardar avisos
          </Button>
          {noticeAt === "save" && <NoticeLine notice={notice} />}
        </div>
      </div>

      <aside className="card flex flex-col gap-4 p-5 xl:sticky xl:top-5">
        <div className="flex items-center justify-between">
          <h3 className="card-title">Estado</h3>
          <span className={`chip ${cfg.status?.active ? "border-status-good/40 text-status-good" : ""}`}>
            <BellRing className="h-3.5 w-3.5" aria-hidden />
            {cfg.status?.active ? "Activos" : "Inactivos"}
          </span>
        </div>
        <dl className="space-y-3 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="label pt-0.5">Último envío</dt>
            <dd className="font-mono text-[12px] text-zinc-200">
              {cfg.status?.last_sent_at ? new Date(cfg.status.last_sent_at * 1000).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" }) : "—"}
            </dd>
          </div>
          {cfg.status?.last_error && (
            <div className="rounded-lg border border-status-critical/30 bg-status-critical/10 p-3 text-xs text-red-200">{cfg.status.last_error}</div>
          )}
        </dl>
        <Button onClick={summary} busy={busy === "summary"} disabled={!cfg.status?.active}>
          Enviar resumen de hoy ahora
        </Button>
        {preview && (
          <pre className="whitespace-pre-wrap rounded-lg border border-white/5 bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
            {preview.replace(/<\/?[bi]>/g, "")}
          </pre>
        )}
      </aside>
    </div>
  );
}

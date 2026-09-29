import { CheckCircle2, Radar, Router, Search, Wand2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api";
import type { AutoConnectResult, ChannelThumb, DiscoveredDevice, DiscoveryResult } from "../../lib/types";
import { Button, Field, NoticeLine, Section, TextInput, errorText, type Notice } from "./Field";

type Step = "search" | "credentials" | "channels" | "done";

function isIp(v: string) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(v.trim());
}

const STEPS: { key: Step; label: string }[] = [
  { key: "search", label: "Buscar" },
  { key: "credentials", label: "Conectar" },
  { key: "channels", label: "Elegir cámara" },
  { key: "done", label: "Listo" },
];

export function CameraWizard({ onAuthError, onApplied }: { onAuthError: (e: unknown) => boolean; onApplied: () => void }) {
  const [step, setStep] = useState<Step>("search");
  const [scan, setScan] = useState<DiscoveryResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [device, setDevice] = useState<DiscoveredDevice | null>(null);
  const [manualIp, setManualIp] = useState("");
  const [user, setUser] = useState("admin");
  const [password, setPassword] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [conn, setConn] = useState<AutoConnectResult | null>(null);
  const [channels, setChannels] = useState<ChannelThumb[]>([]);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [picked, setPicked] = useState<ChannelThumb | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const fail = (e: unknown) => {
    if (!onAuthError(e)) setNotice({ kind: "error", text: errorText(e) });
  };

  const runScan = async () => {
    setScanning(true);
    setNotice(null);
    try {
      const host = window.location.hostname;
      setScan(await api.discover(isIp(host) ? host : null));
    } catch (e) {
      fail(e);
    } finally {
      setScanning(false);
    }
  };

  const choose = (d: DiscoveredDevice) => {
    setDevice(d);
    setConn(null);
    setNotice(null);
    setStep("credentials");
  };

  const connect = async () => {
    if (!device) return;
    setConnecting(true);
    setConn(null);
    setNotice(null);
    try {
      const r = await api.autoconnect({ ip: device.ip, user, password, brand: device.brand });
      setConn(r);
      if (r.ok && r.template) {
        setStep("channels");
        setLoadingChannels(true);
        try {
          const { channels: list } = await api.channels({ ip: device.ip, user, password, template: r.template });
          const all = list.length ? list : [{ channel: 1, video_source: r.video_source!, snapshot: r.result!.snapshot!, width: r.result!.width!, height: r.result!.height! }];
          setChannels(all);
          setPicked(all[0]);
        } finally {
          setLoadingChannels(false);
        }
      }
    } catch (e) {
      fail(e);
    } finally {
      setConnecting(false);
    }
  };

  const apply = async () => {
    if (!picked) return;
    setSaving(true);
    try {
      const current = await api.camera();
      await api.saveCamera({
        camera_name: current.camera_name,
        video_source: picked.video_source,
        vision_mode: "yolo",
        rtsp_transport: "tcp",
        process_fps: current.process_fps,
        yolo_confidence: current.yolo_confidence,
      });
      setStep("done");
      onApplied();
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  };

  const stepIdx = STEPS.findIndex((s) => s.key === step);

  return (
    <Section
      title="Conexión automática"
      description="Busca el grabador o las cámaras en la red del local y prueba solo las direcciones de video. Sólo necesitás el usuario y la clave del grabador."
      aside={
        <ol className="flex items-center gap-1.5">
          {STEPS.map((s, i) => (
            <li key={s.key} className={`flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] ${i <= stepIdx ? "text-zinc-200" : "text-zinc-600"}`}>
              <span className={`flex h-5 w-5 items-center justify-center rounded-full border text-[10px] ${i < stepIdx ? "border-accent bg-accent text-white" : i === stepIdx ? "border-accent text-accent" : "border-white/10"}`}>
                {i + 1}
              </span>
              <span className="hidden sm:inline">{s.label}</span>
              {i < STEPS.length - 1 && <span className="mx-0.5 h-px w-3 bg-white/10" aria-hidden />}
            </li>
          ))}
        </ol>
      }
    >
      {step === "search" && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={runScan} busy={scanning}>
              <Radar className="h-4 w-4" aria-hidden /> Buscar cámaras en la red
            </Button>
            {scanning && <span className="text-xs text-zinc-500">Revisando la red del local… tarda unos segundos.</span>}
            {scan && !scanning && (
              <span className="font-mono text-[11px] text-zinc-500">Redes revisadas: {scan.subnets.join(", ")}</span>
            )}
          </div>

          {scan && scan.devices.length > 0 && (
            <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {scan.devices.map((d) => (
                <li key={d.ip}>
                  <button
                    type="button"
                    onClick={() => choose(d)}
                    className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-black/20 p-3 text-left transition hover:border-accent/50 hover:bg-accent/5"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] text-accent">
                      <Router className="h-4 w-4" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-zinc-100">{d.brand_label}</span>
                      <span className="block truncate font-mono text-[11px] text-zinc-500">
                        {d.ip}
                        {d.title ? ` · ${d.title}` : ""}
                      </span>
                    </span>
                    <span className="flex shrink-0 gap-1">
                      {d.rtsp && <span className="chip px-2 py-0.5 text-[10px]">RTSP</span>}
                      {d.onvif && <span className="chip px-2 py-0.5 text-[10px]">ONVIF</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {scan && scan.devices.length === 0 && (
            <p className="rounded-xl border border-dashed border-white/10 px-4 py-4 text-sm text-zinc-400">
              No apareció ningún equipo de video. Verificá que esta computadora esté conectada al mismo router que el grabador. Si sabés la IP (figura en la app del celular, en <em>Información del dispositivo</em>), ingresala abajo.
            </p>
          )}

          <form
            className="flex flex-wrap items-end gap-3 border-t border-white/5 pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (isIp(manualIp)) choose({ ip: manualIp.trim(), ports: [], brand: null, brand_label: "Equipo ingresado a mano", onvif: false, rtsp: true, title: null });
            }}
          >
            <div className="w-56">
              <Field label="O ingresá la IP" htmlFor="mip">
                <TextInput id="mip" placeholder="192.168.1.64" value={manualIp} onChange={(e) => setManualIp(e.target.value)} />
              </Field>
            </div>
            <Button type="submit" disabled={!isIp(manualIp)}>
              <Search className="h-4 w-4" aria-hidden /> Usar esta IP
            </Button>
          </form>
        </div>
      )}

      {step === "credentials" && device && (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            connect();
          }}
        >
          <p className="text-sm text-zinc-300">
            <span className="text-zinc-100">{device.brand_label}</span> <span className="font-mono text-xs text-zinc-500">{device.ip}</span>
          </p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Usuario del grabador" htmlFor="wuser" hint="Casi siempre es admin.">
              <TextInput id="wuser" autoComplete="off" value={user} onChange={(e) => setUser(e.target.value)} />
            </Field>
            <Field
              label="Clave del grabador"
              htmlFor="wpass"
              hint={
                device.brand === "ezviz"
                  ? "En EZVIZ es el código de verificación de 6 letras que figura en la etiqueta de la cámara."
                  : "La que puso el instalador. No es la clave de la cuenta de la app del celular."
              }
            >
              <TextInput id="wpass" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" busy={connecting}>
              <Wand2 className="h-4 w-4" aria-hidden /> Conectar automáticamente
            </Button>
            <Button onClick={() => setStep("search")}>Volver</Button>
            {connecting && <span className="text-xs text-zinc-500">Probando direcciones de video conocidas…</span>}
          </div>
          {conn && !conn.ok && (
            <div className="rounded-xl border border-status-critical/30 bg-status-critical/10 p-4 text-sm text-red-200">
              {conn.message}
              {conn.tried.length > 0 && <p className="mt-1 font-mono text-[11px] text-red-300/70">{conn.tried.length} direcciones probadas</p>}
            </div>
          )}
        </form>
      )}

      {step === "channels" && (
        <div className="flex flex-col gap-4">
          {conn?.ok && (
            <NoticeLine notice={{ kind: "ok", text: `Conectado: ${conn.brand_label}. Elegí la cámara que mira la caja.` }} />
          )}
          {loadingChannels ? (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="aspect-video animate-pulse rounded-xl bg-white/[0.04]" />
              ))}
            </div>
          ) : (
            <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {channels.map((c) => (
                <li key={c.channel}>
                  <button
                    type="button"
                    onClick={() => setPicked(c)}
                    className={`group relative block w-full overflow-hidden rounded-xl border-2 transition ${picked?.channel === c.channel ? "border-accent" : "border-transparent hover:border-white/20"}`}
                  >
                    <img src={c.snapshot} alt={`Canal ${c.channel}`} className="block aspect-video w-full object-cover" />
                    <span className="absolute left-2 top-2 rounded-md bg-black/70 px-2 py-0.5 font-mono text-[11px] text-zinc-100">Cámara {c.channel}</span>
                    {picked?.channel === c.channel && <CheckCircle2 className="absolute right-2 top-2 h-5 w-5 text-accent" aria-hidden />}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={apply} busy={saving} disabled={!picked || loadingChannels}>
              Usar esta cámara
            </Button>
            <Button onClick={() => setStep("credentials")}>Volver</Button>
          </div>
        </div>
      )}

      {step === "done" && (
        <div className="flex flex-col gap-3">
          <NoticeLine notice={{ kind: "ok", text: `Listo: el sistema ya analiza la cámara ${picked?.channel ?? 1}.` }} />
          <p className="text-sm text-zinc-400">
            Siguiente paso: en <a href="#/configuracion/zonas" className="text-accent underline-offset-2 hover:underline">Zonas</a>, ajustá la zona de fila sobre la imagen real. Después, en <a href="#/configuracion/datos" className="text-accent underline-offset-2 hover:underline">Datos</a>, borrá los datos simulados.
          </p>
          <div>
            <Button onClick={() => setStep("search")}>Conectar otra</Button>
          </div>
        </div>
      )}

      {notice && <div className="mt-3"><NoticeLine notice={notice} /></div>}
    </Section>
  );
}

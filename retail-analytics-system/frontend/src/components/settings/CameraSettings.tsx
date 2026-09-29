import { Camera, FileVideo, Link2, Plug, Trash2, Upload, Webcam } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, uploadVideo } from "../../lib/api";
import { fmtDec1, fmtInt } from "../../lib/format";
import type { CameraSettings as CameraCfg, CameraTestResult, SystemStatus, VideoFile } from "../../lib/types";
import { Button, Field, NoticeLine, NumberInput, Section, Select, TextInput, errorText, type Notice } from "./Field";

type SourceType = "rtsp" | "file" | "webcam" | "url";

const BRANDS = {
  hikvision: {
    label: "Hikvision / HiLook",
    build: (ch: number, sub: boolean) => `/Streaming/Channels/${ch}0${sub ? 2 : 1}`,
  },
  dahua: {
    label: "Dahua / Imou",
    build: (ch: number, sub: boolean) => `/cam/realmonitor?channel=${ch}&subtype=${sub ? 1 : 0}`,
  },
  reolink: { label: "Reolink", build: (ch: number, sub: boolean) => `/h264Preview_${String(ch).padStart(2, "0")}_${sub ? "sub" : "main"}` },
  uniview: { label: "Uniview", build: (ch: number, sub: boolean) => `/unicast/c${ch}/s${sub ? 1 : 0}/live` },
  generic: { label: "Otra (ONVIF)", build: () => "/" },
} as const;
type Brand = keyof typeof BRANDS;

function detectType(src: string): SourceType {
  if (/^rtsps?:\/\//i.test(src)) return "rtsp";
  if (/^\d+$/.test(src)) return "webcam";
  if (/^https?:\/\//i.test(src)) return "url";
  return "file";
}

const SOURCE_TABS: { key: SourceType; label: string; Icon: typeof Camera }[] = [
  { key: "rtsp", label: "Cámara IP (RTSP)", Icon: Camera },
  { key: "file", label: "Video subido", Icon: FileVideo },
  { key: "url", label: "URL HTTP", Icon: Link2 },
  { key: "webcam", label: "Webcam USB", Icon: Webcam },
];

function fmtSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${fmtDec1(bytes / 1024 ** 3)} GB`;
  return `${fmtDec1(bytes / 1024 ** 2)} MB`;
}

export function CameraSettings({ onAuthError }: { onAuthError: (e: unknown) => boolean }) {
  const [form, setForm] = useState<CameraCfg | null>(null);
  const [type, setType] = useState<SourceType>("rtsp");
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [videos, setVideos] = useState<VideoFile[]>([]);
  const [test, setTest] = useState<CameraTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [upload, setUpload] = useState<{ name: string; pct: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [b, setB] = useState({ brand: "hikvision" as Brand, ip: "", port: 554, user: "admin", pass: "", channel: 1, sub: true });

  const loadVideos = useCallback(() => api.videos().then(setVideos).catch(() => setVideos([])), []);

  useEffect(() => {
    api
      .camera()
      .then((c) => {
        setForm(c);
        setType(detectType(c.video_source));
      })
      .catch((e) => setNotice({ kind: "error", text: errorText(e) }));
    loadVideos();
    const tick = () => api.system().then(setStatus).catch(() => undefined);
    tick();
    const id = window.setInterval(tick, 3000);
    return () => window.clearInterval(id);
  }, [loadVideos]);

  if (!form) return <div className="card h-64 animate-pulse" />;

  const set = <K extends keyof CameraCfg>(k: K, v: CameraCfg[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const buildRtsp = () => {
    if (!b.ip.trim()) {
      setNotice({ kind: "error", text: "Completá la IP de la cámara o del NVR." });
      return;
    }
    const creds = b.user ? `${encodeURIComponent(b.user)}${b.pass ? `:${encodeURIComponent(b.pass)}` : ""}@` : "";
    set("video_source", `rtsp://${creds}${b.ip.trim()}:${b.port}${BRANDS[b.brand].build(b.channel, b.sub)}`);
    setNotice(null);
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api.testCamera(form.video_source, form.rtsp_transport));
    } catch (e) {
      if (!onAuthError(e)) setTest({ ok: false, message: errorText(e), width: null, height: null, fps: null, elapsed_ms: 0, snapshot: null });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const saved = await api.saveCamera(form);
      setForm(saved);
      setNotice({ kind: "ok", text: "Guardado. El sistema está reconectando con la nueva fuente." });
    } catch (e) {
      if (!onAuthError(e)) setNotice({ kind: "error", text: errorText(e) });
    } finally {
      setSaving(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setUpload({ name: file.name, pct: 0 });
    try {
      const v = await uploadVideo(file, (pct) => setUpload({ name: file.name, pct }));
      await loadVideos();
      set("video_source", v.path);
      setNotice({ kind: "ok", text: `Video "${v.name}" subido y seleccionado. Guardá para aplicarlo.` });
    } catch (e) {
      if (!onAuthError(e)) setNotice({ kind: "error", text: errorText(e) });
    } finally {
      setUpload(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeVideo = async (v: VideoFile) => {
    if (!window.confirm(`¿Borrar el video "${v.name}"?`)) return;
    try {
      await api.deleteVideo(v.name);
      await loadVideos();
    } catch (e) {
      if (!onAuthError(e)) setNotice({ kind: "error", text: errorText(e) });
    }
  };

  const vision = status?.vision;

  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex flex-col gap-4">
        <Section title="Fuente de video" description="Elegí de dónde toma la imagen el sistema. Probá la conexión antes de guardar.">
          <div className="mb-5 flex flex-wrap gap-1.5" role="tablist">
            {SOURCE_TABS.map(({ key, label, Icon }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={type === key}
                onClick={() => {
                  setType(key);
                  if (key === "webcam" && !/^\d+$/.test(form.video_source)) set("video_source", "0");
                }}
                className={`chip px-3 py-1.5 text-xs transition ${type === key ? "border-accent/50 bg-accent/10 text-zinc-50" : "text-zinc-400 hover:text-zinc-200"}`}
              >
                <Icon className={`h-3.5 w-3.5 ${type === key ? "text-accent" : ""}`} aria-hidden />
                {label}
              </button>
            ))}
          </div>

          {type === "rtsp" && (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3 rounded-xl border border-white/5 bg-black/20 p-4 md:grid-cols-4">
                <div className="col-span-2">
                  <Field label="Marca" htmlFor="brand">
                    <Select id="brand" value={b.brand} onChange={(e) => setB({ ...b, brand: e.target.value as Brand })}>
                      {Object.entries(BRANDS).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <div className="col-span-2 md:col-span-1">
                  <Field label="IP" htmlFor="ip">
                    <TextInput id="ip" placeholder="192.168.1.64" value={b.ip} onChange={(e) => setB({ ...b, ip: e.target.value })} />
                  </Field>
                </div>
                <Field label="Puerto" htmlFor="port">
                  <NumberInput id="port" value={b.port} onValue={(n) => setB({ ...b, port: n })} />
                </Field>
                <Field label="Usuario" htmlFor="user">
                  <TextInput id="user" autoComplete="off" value={b.user} onChange={(e) => setB({ ...b, user: e.target.value })} />
                </Field>
                <Field label="Clave" htmlFor="pass">
                  <TextInput id="pass" type="password" autoComplete="new-password" value={b.pass} onChange={(e) => setB({ ...b, pass: e.target.value })} />
                </Field>
                <Field label="Canal" htmlFor="ch">
                  <NumberInput id="ch" min={1} value={b.channel} onValue={(n) => setB({ ...b, channel: n })} />
                </Field>
                <Field label="Calidad" htmlFor="sub">
                  <Select id="sub" value={b.sub ? "sub" : "main"} onChange={(e) => setB({ ...b, sub: e.target.value === "sub" })}>
                    <option value="sub">Substream (recomendado)</option>
                    <option value="main">Principal</option>
                  </Select>
                </Field>
                <div className="col-span-2 flex items-end md:col-span-4">
                  <Button onClick={buildRtsp}>Armar URL</Button>
                </div>
              </div>
              <Field label="URL RTSP" htmlFor="src" hint="La clave guardada se muestra como ••••••. Si no la tocás, se conserva.">
                <TextInput id="src" className="font-mono text-[13px]" value={form.video_source} onChange={(e) => set("video_source", e.target.value)} placeholder="rtsp://usuario:clave@IP:554/…" />
              </Field>
              <Field label="Transporte" htmlFor="tr" hint="TCP es más estable en redes con Wi-Fi o switches domésticos.">
                <Select id="tr" value={form.rtsp_transport} onChange={(e) => set("rtsp_transport", e.target.value as "tcp" | "udp")}>
                  <option value="tcp">TCP</option>
                  <option value="udp">UDP</option>
                </Select>
              </Field>
            </div>
          )}

          {type === "file" && (
            <div className="flex flex-col gap-3">
              <input ref={fileRef} type="file" accept="video/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  onFile(e.dataTransfer.files?.[0]);
                }}
                className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 bg-black/20 px-4 py-8 text-sm text-zinc-400 transition hover:border-accent/50 hover:text-zinc-200"
              >
                <Upload className="h-5 w-5 text-accent" aria-hidden />
                {upload ? `Subiendo ${upload.name}… ${upload.pct} %` : "Arrastrá un video acá o hacé clic para elegirlo (mp4, mov, mkv, avi, webm)"}
                {upload && (
                  <span className="mt-1 h-1 w-48 overflow-hidden rounded-full bg-zinc-800">
                    <span className="block h-full bg-accent" style={{ width: `${upload.pct}%` }} />
                  </span>
                )}
              </button>
              <ul className="divide-y divide-white/5 rounded-xl border border-white/5">
                {videos.length === 0 && <li className="px-4 py-3 text-sm text-zinc-500">Todavía no hay videos subidos.</li>}
                {videos.map((v) => (
                  <li key={v.path} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <label className="flex min-w-0 cursor-pointer items-center gap-3">
                      <input
                        type="radio"
                        name="video"
                        className="accent-rose-500"
                        checked={form.video_source === v.path}
                        onChange={() => set("video_source", v.path)}
                      />
                      <span className="truncate text-sm text-zinc-200">{v.name}</span>
                      <span className="font-mono text-[11px] text-zinc-500">{fmtSize(v.size_bytes)}</span>
                    </label>
                    <button type="button" onClick={() => removeVideo(v)} className="text-zinc-500 hover:text-red-300" aria-label={`Borrar ${v.name}`}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {type === "url" && (
            <Field label="URL del stream" htmlFor="url" hint="MJPEG o HLS publicado por la cámara o un NVR (http:// o https://).">
              <TextInput id="url" className="font-mono text-[13px]" value={form.video_source} onChange={(e) => set("video_source", e.target.value)} placeholder="http://192.168.1.64/video.mjpg" />
            </Field>
          )}

          {type === "webcam" && (
            <Field label="Índice de dispositivo" htmlFor="cam" hint="0 es la primera cámara USB conectada al equipo donde corre el sistema.">
              <NumberInput id="cam" min={0} value={Number(form.video_source) || 0} onValue={(n) => set("video_source", String(Number.isFinite(n) ? n : 0))} />
            </Field>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-white/5 pt-4">
            <Button onClick={runTest} busy={testing}>
              <Plug className="h-4 w-4" aria-hidden /> Probar conexión
            </Button>
            {testing && <span className="text-xs text-zinc-500">Puede tardar hasta 8 s si la cámara no responde…</span>}
          </div>
          {test && (
            <div className={`mt-4 overflow-hidden rounded-xl border ${test.ok ? "border-status-good/30" : "border-status-critical/30"}`}>
              {test.snapshot && <img src={test.snapshot} alt="Cuadro de prueba" className="block w-full" />}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 bg-black/30 px-4 py-2.5 text-sm">
                <NoticeLine notice={{ kind: test.ok ? "ok" : "error", text: test.message }} />
                {test.ok && (
                  <span className="font-mono text-xs text-zinc-400">
                    {test.width}×{test.height} · {test.fps ? `${fmtDec1(test.fps)} fps` : "fps n/d"} · {fmtInt(test.elapsed_ms)} ms
                  </span>
                )}
              </div>
            </div>
          )}
        </Section>

        <Section title="Procesamiento" description="Cuánta capacidad de cómputo usa el análisis de video.">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Field label="Nombre de la cámara" htmlFor="name">
              <TextInput id="name" value={form.camera_name} onChange={(e) => set("camera_name", e.target.value)} />
            </Field>
            <Field label="Modo" htmlFor="mode" hint={form.vision_mode === "auto" ? "Si la cámara falla al iniciar, pasa a modo demo." : form.vision_mode === "yolo" ? "Reintenta la cámara; nunca muestra datos simulados." : "Datos sintéticos para demostraciones."}>
              <Select id="mode" value={form.vision_mode} onChange={(e) => set("vision_mode", e.target.value as CameraCfg["vision_mode"])}>
                <option value="yolo">Cámara real (recomendado)</option>
                <option value="auto">Automático</option>
                <option value="simulate">Demo simulada</option>
              </Select>
            </Field>
            <Field label="Cuadros por segundo" htmlFor="fps" hint="8 fps alcanzan para conteo y filas en CPU.">
              <NumberInput id="fps" min={1} max={30} step={1} unit="fps" value={form.process_fps} onValue={(n) => set("process_fps", n)} />
            </Field>
            <Field label="Confianza mínima" htmlFor="conf" hint="Más alto: menos falsos positivos, pero puede perder personas lejanas.">
              <NumberInput id="conf" min={5} max={95} step={5} unit="%" value={Math.round(form.yolo_confidence * 100)} onValue={(n) => set("yolo_confidence", n / 100)} />
            </Field>
          </div>
        </Section>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={save} busy={saving}>
            Guardar y aplicar
          </Button>
          <NoticeLine notice={notice} />
        </div>
      </div>

      <aside className="card h-fit p-5 xl:sticky xl:top-5">
        <h3 className="card-title">Estado en vivo</h3>
        {!vision ? (
          <p className="mt-3 text-sm text-zinc-500">Consultando…</p>
        ) : (
          <dl className="mt-4 space-y-3 text-sm">
            {(
              [
                ["Modo", vision.mode === "yolo" ? "Cámara real · YOLOv8" : vision.mode === "simulate" ? "Demo simulada" : "Iniciando"],
                ["Conexión", vision.connected ? "Conectada" : "Sin señal"],
                ["Fuente", vision.video_source],
                ["Procesando", `${fmtDec1(vision.processing_fps)} fps`],
                ["Resolución", vision.frame_size ? `${vision.frame_size[0]}×${vision.frame_size[1]}` : "—"],
                ["Personas en seguimiento", fmtInt(vision.active_tracks)],
                ["Base de datos", status.database.ready ? (status.database.timescale ? "TimescaleDB" : "PostgreSQL") : "No disponible"],
                ["Tiempo real", status.redis_pubsub ? "Redis Pub/Sub" : "Local (sin Redis)"],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="flex items-start justify-between gap-4">
                <dt className="label shrink-0 pt-0.5">{k}</dt>
                <dd className="break-all text-right font-mono text-[12px] text-zinc-200">{v}</dd>
              </div>
            ))}
            {vision.last_error && (
              <div className="rounded-lg border border-status-critical/30 bg-status-critical/10 p-3 text-xs text-red-200">
                <span className="label mb-1 block text-red-300">Último error</span>
                {vision.last_error}
              </div>
            )}
          </dl>
        )}
      </aside>
    </div>
  );
}

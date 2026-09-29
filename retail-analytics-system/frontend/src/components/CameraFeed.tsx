import { Flame, Scan, Shapes, Video, VideoOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { streamUrl } from "../lib/api";
import { drawBackground } from "../lib/scene";
import { fmtClock, fmtDec1, fmtDuration } from "../lib/format";
import type { SourceMode, Track, Zone } from "../lib/types";

interface CameraFeedProps {
  cameraName: string;
  sourceMode: SourceMode;
  hasVideo: boolean;
  streamConnected: boolean;
  frameSize: [number, number] | null;
  processingFps: number;
  tracks: Track[];
  tracksTs: number;
  zones: Zone[];
  peopleCount: number;
  queueLength: number;
}

type BBox = [number, number, number, number];

interface AnimatedTrack {
  from: BBox;
  to: BBox;
  start: number;
  track: Track;
}

const HEAT_W = 64;
const HEAT_H = 36;
const HEAT_DECAY = 0.9992; // por cuadro (~60 fps): vida media ≈ 15 s
const ANIM_MS = 220;

const ROSE = "#f43f5e";
const INK = "#e4e4e7";

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function drawZones(ctx: CanvasRenderingContext2D, zones: Zone[], w: number, h: number, queueLength: number) {
  for (const z of zones) {
    if (z.polygon.length < 3) continue;
    const isQueue = z.kind === "queue";
    ctx.beginPath();
    z.polygon.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * w, y * h) : ctx.lineTo(x * w, y * h)));
    ctx.closePath();
    ctx.fillStyle = isQueue ? "rgba(244,63,94,0.07)" : "rgba(255,255,255,0.015)";
    ctx.fill();
    ctx.setLineDash(isQueue ? [6, 4] : [3, 5]);
    ctx.lineWidth = isQueue ? 1.5 : 1;
    ctx.strokeStyle = isQueue ? "rgba(244,63,94,0.7)" : "rgba(228,228,231,0.18)";
    ctx.stroke();
    ctx.setLineDash([]);

    const [lx, ly] = z.polygon[0];
    const label = isQueue ? `${z.name} · ${queueLength}${z.capacity ? `/${z.capacity}` : ""}` : z.name;
    ctx.font = "500 11px 'IBM Plex Sans', sans-serif";
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = isQueue ? "rgba(225,29,72,0.9)" : "rgba(39,39,42,0.9)";
    ctx.beginPath();
    ctx.roundRect(lx * w + 6, ly * h + 6, tw + 14, 20, 6);
    ctx.fill();
    ctx.fillStyle = "#fafafa";
    ctx.fillText(label, lx * w + 13, ly * h + 20);
  }
}

function drawBox(ctx: CanvasRenderingContext2D, b: BBox, t: Track, w: number, h: number) {
  const x1 = b[0] * w;
  const y1 = b[1] * h;
  const bw = (b[2] - b[0]) * w;
  const bh = (b[3] - b[1]) * h;
  const color = t.in_queue ? ROSE : INK;
  const c = Math.min(12, bw * 0.3, bh * 0.3);

  ctx.fillStyle = t.in_queue ? "rgba(244,63,94,0.10)" : "rgba(228,228,231,0.04)";
  ctx.fillRect(x1, y1, bw, bh);

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash(t.confirmed ? [] : [4, 3]);
  ctx.beginPath();
  // Esquinas tipo visor.
  ctx.moveTo(x1, y1 + c);
  ctx.lineTo(x1, y1);
  ctx.lineTo(x1 + c, y1);
  ctx.moveTo(x1 + bw - c, y1);
  ctx.lineTo(x1 + bw, y1);
  ctx.lineTo(x1 + bw, y1 + c);
  ctx.moveTo(x1 + bw, y1 + bh - c);
  ctx.lineTo(x1 + bw, y1 + bh);
  ctx.lineTo(x1 + bw - c, y1 + bh);
  ctx.moveTo(x1 + c, y1 + bh);
  ctx.lineTo(x1, y1 + bh);
  ctx.lineTo(x1, y1 + bh - c);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = t.in_queue ? "rgba(244,63,94,0.35)" : "rgba(228,228,231,0.15)";
  ctx.strokeRect(x1, y1, bw, bh);

  const label = t.in_queue
    ? `#${t.track_id} · fila ${fmtDuration(t.queue_wait_seconds)}`
    : `#${t.track_id} · ${fmtDuration(t.dwell_seconds)}`;
  ctx.font = "500 10px 'IBM Plex Mono', monospace";
  const tw = ctx.measureText(label).width;
  const ly = Math.max(y1 - 18, 2);
  const lx = Math.max(2, Math.min(x1, w - tw - 12));
  ctx.fillStyle = t.in_queue ? "rgba(225,29,72,0.92)" : "rgba(24,24,27,0.88)";
  ctx.beginPath();
  ctx.roundRect(lx, ly, tw + 10, 15, 4);
  ctx.fill();
  ctx.fillStyle = "#fafafa";
  ctx.fillText(label, lx + 5, ly + 11);
}

export function CameraFeed(props: CameraFeedProps) {
  const {
    cameraName,
    sourceMode,
    hasVideo,
    streamConnected,
    frameSize,
    processingFps,
    tracks,
    tracksTs,
    zones,
    peopleCount,
    queueLength,
  } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<Map<number, AnimatedTrack>>(new Map());
  const heatRef = useRef<Float32Array>(new Float32Array(HEAT_W * HEAT_H));
  const heatCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const zonesRef = useRef(zones);
  const queueRef = useRef(queueLength);
  const [videoFailed, setVideoFailed] = useState(false);
  const [layers, setLayers] = useState({ boxes: true, zones: true, heat: true });
  const layersRef = useRef(layers);
  const [clock, setClock] = useState(Date.now());

  zonesRef.current = zones;
  queueRef.current = queueLength;
  layersRef.current = layers;

  const showVideo = hasVideo && !videoFailed && sourceMode === "yolo";
  const showVideoRef = useRef(showVideo);
  showVideoRef.current = showVideo;
  const aspect = frameSize ? frameSize[0] / frameSize[1] : 16 / 9;

  useEffect(() => {
    if (hasVideo) setVideoFailed(false);
  }, [hasVideo]);

  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Nuevos tracks: animamos desde la posición mostrada y acumulamos calor.
  useEffect(() => {
    const now = performance.now();
    const map = animRef.current;
    const next = new Map<number, AnimatedTrack>();
    for (const t of tracks) {
      const prev = map.get(t.track_id);
      let from: BBox = t.bbox;
      if (prev) {
        const k = Math.min(1, (now - prev.start) / ANIM_MS);
        from = prev.from.map((v, i) => lerp(v, prev.to[i], k)) as BBox;
      }
      next.set(t.track_id, { from, to: t.bbox, start: now, track: t });

      const fx = Math.floor(((t.bbox[0] + t.bbox[2]) / 2) * HEAT_W);
      const fy = Math.floor(t.bbox[3] * HEAT_H) - 1;
      const heat = heatRef.current;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const x = fx + dx;
          const y = fy + dy;
          if (x < 0 || y < 0 || x >= HEAT_W || y >= HEAT_H) continue;
          const wgt = Math.exp(-(dx * dx + dy * dy) / 2.5);
          heat[y * HEAT_W + x] = Math.min(heat[y * HEAT_W + x] + 0.06 * wgt, 1);
        }
      }
    }
    animRef.current = next;
  }, [tracks, tracksTs]);

  // Render loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const heatCanvas = document.createElement("canvas");
    heatCanvas.width = HEAT_W;
    heatCanvas.height = HEAT_H;
    heatCanvasRef.current = heatCanvas;
    const hctx = heatCanvas.getContext("2d")!;
    const heatImg = hctx.createImageData(HEAT_W, HEAT_H);

    let w = 0;
    let h = 0;
    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    let raf = 0;
    const frame = () => {
      const now = performance.now();
      const L = layersRef.current;
      ctx.clearRect(0, 0, w, h);
      if (!showVideoRef.current) drawBackground(ctx, w, h);

      const heat = heatRef.current;
      for (let i = 0; i < heat.length; i++) heat[i] *= HEAT_DECAY;
      if (L.heat) {
        for (let i = 0; i < heat.length; i++) {
          const v = heat[i];
          const o = i * 4;
          heatImg.data[o] = 244;
          heatImg.data[o + 1] = Math.round(63 + 120 * v * v);
          heatImg.data[o + 2] = 94;
          heatImg.data[o + 3] = Math.round(Math.min(v * 1.4, 1) * 150);
        }
        hctx.putImageData(heatImg, 0, 0);
        ctx.save();
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.globalCompositeOperation = "screen";
        ctx.drawImage(heatCanvas, 0, 0, w, h);
        ctx.restore();
      }

      if (L.zones) drawZones(ctx, zonesRef.current, w, h, queueRef.current);

      if (L.boxes) {
        for (const a of animRef.current.values()) {
          const k = Math.min(1, (now - a.start) / ANIM_MS);
          const e = 1 - (1 - k) ** 3;
          const b = a.from.map((v, i) => lerp(v, a.to[i], e)) as BBox;
          drawBox(ctx, b, a.track, w, h);
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  const confirmed = tracks.filter((t) => t.confirmed);
  const avgConf = confirmed.length ? confirmed.reduce((acc, t) => acc + t.confidence, 0) / confirmed.length : null;
  const longest = tracks.reduce((m, t) => Math.max(m, t.dwell_seconds), 0);
  const telemetry: [string, string][] = [
    ["Tracks activos", String(tracks.length)],
    ["Confianza media", avgConf == null ? "—" : `${fmtDec1(avgConf * 100)} %`],
    ["Mayor permanencia", tracks.length ? fmtDuration(longest) : "—"],
    ["Resolución", frameSize ? `${frameSize[0]}×${frameSize[1]}` : "—"],
  ];

  const toggle = (key: keyof typeof layers) => setLayers((l) => ({ ...l, [key]: !l[key] }));
  const live = sourceMode === "yolo" ? streamConnected : true;

  return (
    <section className="card flex h-full flex-col overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4">
        <div className="flex items-center gap-3">
          <span className="relative flex h-2.5 w-2.5">
            {live && <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-accent" />}
            <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${live ? "bg-accent" : "bg-zinc-600"}`} />
          </span>
          <div>
            <h2 className="card-title">Cámara · {cameraName}</h2>
            <p className="card-sub">
              {sourceMode === "yolo" ? "YOLOv8 + ByteTrack" : sourceMode === "simulate" ? "Modo simulado" : "Iniciando"} ·{" "}
              {fmtDec1(processingFps)} fps
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {(
            [
              ["boxes", "Personas", Scan],
              ["zones", "Zonas", Shapes],
              ["heat", "Calor", Flame],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              onClick={() => toggle(key)}
              aria-pressed={layers[key]}
              className={`chip transition ${layers[key] ? "border-accent/40 text-zinc-100" : "text-zinc-500"}`}
            >
              <Icon className={`h-3.5 w-3.5 ${layers[key] ? "text-accent" : ""}`} aria-hidden />
              {label}
            </button>
          ))}
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-3 p-4 pt-3">
        <div
          ref={containerRef}
          className="relative w-full overflow-hidden rounded-xl border border-white/5 bg-black"
          style={{ aspectRatio: `${aspect}` }}
        >
          {showVideo && (
            <img
              src={streamUrl}
              alt={`Stream de ${cameraName}`}
              className="absolute inset-0 h-full w-full object-fill"
              onError={() => setVideoFailed(true)}
            />
          )}
          <canvas ref={canvasRef} className="absolute inset-0" />

          <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2">
            <span className="rounded-md bg-accent-strong/90 px-2 py-0.5 text-[10px] font-bold tracking-widest text-white">
              {sourceMode === "simulate" ? "DEMO" : live ? "EN VIVO" : "SIN SEÑAL"}
            </span>
            {sourceMode === "yolo" && !showVideo && (
              <span className="chip bg-black/60">
                <VideoOff className="h-3.5 w-3.5" aria-hidden /> Reconectando stream…
              </span>
            )}
          </div>
          <div className="pointer-events-none absolute right-3 top-3 rounded-md bg-black/60 px-2 py-0.5 font-mono text-[11px] text-zinc-300">
            {fmtClock(clock)}
          </div>
          <div className="pointer-events-none absolute bottom-3 right-3 flex gap-2">
            <span className="chip bg-black/60">
              <Video className="h-3.5 w-3.5 text-accent" aria-hidden />
              {peopleCount} personas
            </span>
            <span className="chip bg-black/60">
              <span className="h-2 w-2 rounded-sm bg-accent" aria-hidden />
              {queueLength} en fila
            </span>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {telemetry.map(([k, v]) => (
            <div key={k} className="rounded-lg border border-white/5 bg-black/20 px-3 py-2">
              <dt className="label">{k}</dt>
              <dd className="font-mono text-sm text-zinc-100">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

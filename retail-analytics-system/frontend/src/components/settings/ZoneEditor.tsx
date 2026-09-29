import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { api, snapshotUrl } from "../../lib/api";
import { drawBackground } from "../../lib/scene";
import type { ZoneKind, ZoneRecord } from "../../lib/types";
import { Button, Field, NoticeLine, NumberInput, Section, Select, TextInput, errorText, type Notice } from "./Field";

type Point = [number, number];

interface Draft {
  id: number | null;
  name: string;
  kind: ZoneKind;
  capacity: number | null;
  active: boolean;
  polygon: Point[];
}

const KINDS: Record<ZoneKind, { label: string; short: string; hint: string; fill: string; stroke: string }> = {
  queue: {
    label: "Fila de caja",
    short: "Fila",
    hint: "Quien pisa esta zona cuenta como persona en fila.",
    fill: "rgba(244,63,94,0.06)",
    stroke: "rgba(244,63,94,0.45)",
  },
  service: {
    label: "Punto de atención",
    short: "Atención",
    hint: "Frente a la caja, donde se paga. Quien pasa 3 s acá cuenta como atendido; quien hizo fila y se va sin pasar, como abandono.",
    fill: "rgba(253,164,175,0.08)",
    stroke: "rgba(253,164,175,0.6)",
  },
  staff: {
    label: "Personal (detrás del mostrador)",
    short: "Personal",
    hint: "Quien pisa esta zona es empleado: no cuenta como cliente. Si hay fila y nadie acá, alerta de caja sin atender.",
    fill: "rgba(99,102,241,0.08)",
    stroke: "rgba(129,140,248,0.6)",
  },
  area: {
    label: "Área informativa",
    short: "Área",
    hint: "Salón, góndola o vidriera. Sólo se muestra en el visor.",
    fill: "rgba(255,255,255,0.03)",
    stroke: "rgba(228,228,231,0.3)",
  },
};

const EMPTY: Draft = { id: null, name: "Nueva zona", kind: "queue", capacity: 6, active: true, polygon: [] };
const CLOSE_PX = 12;

const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;

function toDraft(z: ZoneRecord): Draft {
  return { id: z.id, name: z.name, kind: z.kind, capacity: z.capacity, active: z.active, polygon: z.polygon.map(([x, y]) => [x, y]) };
}

export function ZoneEditor({ onAuthError, frameSize }: { onAuthError: (e: unknown) => boolean; frameSize: [number, number] | null }) {
  const [zones, setZones] = useState<ZoneRecord[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [hoverPt, setHoverPt] = useState<Point | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [snapTs, setSnapTs] = useState(Date.now());
  const [hasSnap, setHasSnap] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const bgRef = useRef<HTMLCanvasElement>(null);

  const aspect = frameSize ? frameSize[0] / frameSize[1] : 16 / 9;

  const load = useCallback(async () => {
    try {
      const list = await api.zones();
      setZones(list);
      return list;
    } catch (e) {
      setNotice({ kind: "error", text: errorText(e) });
      return [];
    }
  }, []);

  useEffect(() => {
    load().then((list) => {
      if (list.length) setDraft(toDraft(list[0]));
    });
  }, [load]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = bgRef.current;
    if (!c || hasSnap || !size.w) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = size.w * dpr;
    c.height = size.h * dpr;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBackground(ctx, size.w, size.h);
  }, [hasSnap, size]);

  const toNorm = (e: { clientX: number; clientY: number }): Point => {
    const r = boxRef.current!.getBoundingClientRect();
    return [clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height)];
  };
  const px = ([x, y]: Point) => [x * size.w, y * size.h] as const;

  const updatePoly = (fn: (p: Point[]) => Point[]) => setDraft((d) => (d ? { ...d, polygon: fn(d.polygon) } : d));

  const onSvgPointerDown = (e: RPointerEvent<SVGSVGElement>) => {
    if (!drawing || !draft) return;
    const p = toNorm(e);
    if (draft.polygon.length >= 3) {
      const [fx, fy] = px(draft.polygon[0]);
      const [cx, cy] = px(p);
      if (Math.hypot(fx - cx, fy - cy) < CLOSE_PX) {
        setDrawing(false);
        return;
      }
    }
    updatePoly((poly) => [...poly, p]);
  };

  const onSvgPointerMove = (e: RPointerEvent<SVGSVGElement>) => {
    const p = toNorm(e);
    if (drawing) setHoverPt(p);
    if (dragIdx !== null) updatePoly((poly) => poly.map((q, i) => (i === dragIdx ? p : q)));
  };

  const startDrag = (e: RPointerEvent, idx: number) => {
    e.stopPropagation();
    (e.currentTarget as SVGGraphicsElement).ownerSVGElement?.setPointerCapture(e.pointerId);
    setDragIdx(idx);
  };

  const insertAt = (e: RPointerEvent, idx: number) => {
    e.stopPropagation();
    updatePoly((poly) => {
      const a = poly[idx];
      const b = poly[(idx + 1) % poly.length];
      const mid: Point = [clamp((a[0] + b[0]) / 2), clamp((a[1] + b[1]) / 2)];
      return [...poly.slice(0, idx + 1), mid, ...poly.slice(idx + 1)];
    });
    (e.currentTarget as SVGGraphicsElement).ownerSVGElement?.setPointerCapture(e.pointerId);
    setDragIdx(idx + 1);
  };

  const removeVertex = (idx: number) => {
    if (!draft || draft.polygon.length <= 3) return;
    updatePoly((poly) => poly.filter((_, i) => i !== idx));
  };

  const select = (z: ZoneRecord) => {
    setDrawing(false);
    setNotice(null);
    setDraft(toDraft(z));
  };

  const startNew = () => {
    setNotice(null);
    setDraft({ ...EMPTY, polygon: [] });
    setDrawing(true);
  };

  const save = async () => {
    if (!draft) return;
    if (draft.polygon.length < 3) {
      setNotice({ kind: "error", text: "La zona necesita al menos 3 puntos." });
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: draft.name,
        kind: draft.kind,
        capacity: draft.capacity && draft.capacity > 0 ? draft.capacity : null,
        active: draft.active,
        polygon: draft.polygon,
      };
      const saved = draft.id == null ? await api.createZone(body) : await api.updateZone(draft.id, body);
      await load();
      setDraft(toDraft(saved));
      setDrawing(false);
      setNotice({ kind: "ok", text: "Zona guardada. El análisis ya usa la nueva forma." });
    } catch (e) {
      if (!onAuthError(e)) setNotice({ kind: "error", text: errorText(e) });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!draft?.id || !window.confirm(`¿Eliminar la zona "${draft.name}"?`)) return;
    try {
      await api.deleteZone(draft.id);
      const list = await load();
      setDraft(list[0] ? toDraft(list[0]) : null);
      setNotice({ kind: "ok", text: "Zona eliminada." });
    } catch (e) {
      if (!onAuthError(e)) setNotice({ kind: "error", text: errorText(e) });
    }
  };

  const poly = draft?.polygon ?? [];
  const path = (pts: Point[]) => pts.map((p) => px(p).join(",")).join(" ");

  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Section
        title="Dibujo de zonas"
        description={
          drawing
            ? "Hacé clic para agregar puntos. Cerrá la figura tocando el primer punto."
            : "Arrastrá los vértices para ajustar. Los círculos chicos agregan un punto; doble clic en un vértice lo quita."
        }
        aside={
          <Button onClick={() => { setHasSnap(true); setSnapTs(Date.now()); }}>
            <RefreshCw className="h-4 w-4" aria-hidden /> Actualizar cuadro
          </Button>
        }
      >
        <div
          ref={boxRef}
          className={`relative w-full select-none overflow-hidden rounded-xl border border-white/10 bg-black ${drawing ? "cursor-crosshair" : ""}`}
          style={{ aspectRatio: `${aspect}` }}
        >
          {hasSnap ? (
            <img
              src={`${snapshotUrl}?t=${snapTs}`}
              alt="Cuadro actual de la cámara"
              className="absolute inset-0 h-full w-full object-fill"
              onError={() => setHasSnap(false)}
              draggable={false}
            />
          ) : (
            <canvas ref={bgRef} className="absolute inset-0 h-full w-full" />
          )}
          {size.w > 0 && (
            <svg
              className="absolute inset-0 h-full w-full touch-none"
              onPointerDown={onSvgPointerDown}
              onPointerMove={onSvgPointerMove}
              onPointerUp={() => setDragIdx(null)}
              onPointerLeave={() => setHoverPt(null)}
            >
              {zones
                .filter((z) => z.id !== draft?.id)
                .map((z) => (
                  <g key={z.id} onPointerDown={(e) => { if (!drawing) { e.stopPropagation(); select(z); } }} className="cursor-pointer">
                    <polygon
                      points={path(z.polygon)}
                      fill={KINDS[z.kind]?.fill ?? KINDS.area.fill}
                      stroke={KINDS[z.kind]?.stroke ?? KINDS.area.stroke}
                      strokeDasharray="5 4"
                      strokeWidth={1.2}
                    />
                    <text x={px(z.polygon[0])[0] + 8} y={px(z.polygon[0])[1] + 18} className="fill-zinc-300" style={{ font: "500 11px 'IBM Plex Sans'" }}>
                      {z.name}
                    </text>
                  </g>
                ))}

              {poly.length > 0 && (
                <>
                  {drawing ? (
                    <polyline
                      points={path(hoverPt ? [...poly, hoverPt] : poly)}
                      fill="rgba(244,63,94,0.10)"
                      stroke="#f43f5e"
                      strokeWidth={2}
                      strokeDasharray="6 4"
                    />
                  ) : (
                    <polygon points={path(poly)} fill="rgba(244,63,94,0.14)" stroke="#f43f5e" strokeWidth={2} />
                  )}
                  {!drawing &&
                    poly.map((a, i) => {
                      const b = poly[(i + 1) % poly.length];
                      const [mx, my] = px([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
                      return (
                        <circle key={`m${i}`} cx={mx} cy={my} r={4} fill="#18181b" stroke="#fda4af" strokeWidth={1.5} className="cursor-copy" onPointerDown={(e) => insertAt(e, i)} />
                      );
                    })}
                  {poly.map((p, i) => {
                    const [x, y] = px(p);
                    const first = i === 0 && drawing && poly.length >= 3;
                    return (
                      <circle
                        key={`v${i}`}
                        cx={x}
                        cy={y}
                        r={first ? 9 : 6.5}
                        fill={first ? "#f43f5e" : "#fafafa"}
                        stroke="#e11d48"
                        strokeWidth={2}
                        className={drawing ? "" : "cursor-grab active:cursor-grabbing"}
                        onPointerDown={(e) => (drawing ? undefined : startDrag(e, i))}
                        onDoubleClick={() => removeVertex(i)}
                      />
                    );
                  })}
                </>
              )}
            </svg>
          )}
        </div>
        {!hasSnap && (
          <p className="mt-2 text-xs text-zinc-500">
            No hay imagen de cámara (modo demo o sin señal): se muestra un plano de referencia. Conectá la cámara para dibujar sobre la imagen real.
          </p>
        )}
      </Section>

      <div className="flex flex-col gap-4">
        <Section
          title="Zonas"
          aside={
            <Button onClick={startNew}>
              <Plus className="h-4 w-4" aria-hidden /> Nueva
            </Button>
          }
        >
          <ul className="flex flex-col gap-1.5">
            {zones.length === 0 && <li className="text-sm text-zinc-500">No hay zonas. Creá la zona de fila de caja.</li>}
            {zones.map((z) => (
              <li key={z.id}>
                <button
                  type="button"
                  onClick={() => select(z)}
                  className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition ${draft?.id === z.id ? "border-accent/50 bg-accent/10 text-zinc-50" : "border-white/5 bg-black/20 text-zinc-300 hover:border-white/15"}`}
                >
                  <span className="truncate">{z.name}</span>
                  <span className="label">{KINDS[z.kind]?.short ?? z.kind}{z.active ? "" : " · off"}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>

        {draft && (
          <Section title={draft.id == null ? "Nueva zona" : "Editar zona"}>
            <div className="flex flex-col gap-4">
              <Field label="Nombre" htmlFor="zname">
                <TextInput id="zname" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </Field>
              <Field label="Tipo" htmlFor="zkind" hint={KINDS[draft.kind].hint}>
                <Select id="zkind" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as ZoneKind })}>
                  {(Object.keys(KINDS) as ZoneKind[]).map((k) => (
                    <option key={k} value={k}>
                      {KINDS[k].label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Capacidad" htmlFor="zcap" hint="Personas que entran en la zona antes de considerarla llena.">
                <NumberInput id="zcap" min={1} unit="pers." value={draft.capacity ?? NaN} onValue={(n) => setDraft({ ...draft, capacity: Number.isFinite(n) ? n : null })} />
              </Field>
              <label className="flex items-center gap-2 text-sm text-zinc-300">
                <input type="checkbox" className="accent-rose-500" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
                Zona activa
              </label>
              <div className="flex flex-wrap gap-2 border-t border-white/5 pt-4">
                <Button variant="primary" onClick={save} busy={saving} disabled={drawing && poly.length < 3}>
                  Guardar zona
                </Button>
                <Button onClick={() => { updatePoly(() => []); setDrawing(true); }}>
                  <Pencil className="h-4 w-4" aria-hidden /> Redibujar
                </Button>
                {draft.id != null && (
                  <Button variant="danger" onClick={remove}>
                    <Trash2 className="h-4 w-4" aria-hidden /> Eliminar
                  </Button>
                )}
              </div>
              <p className="font-mono text-[11px] text-zinc-500">{poly.length} puntos</p>
              <NoticeLine notice={notice} />
            </div>
          </Section>
        )}
        {!draft && <NoticeLine notice={notice} />}
      </div>
    </div>
  );
}

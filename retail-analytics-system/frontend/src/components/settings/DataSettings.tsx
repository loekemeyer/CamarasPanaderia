import { Download, Eraser } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, exportCsvUrl } from "../../lib/api";
import { fmtInt } from "../../lib/format";
import type { DataStats } from "../../lib/types";
import { Button, Field, NoticeLine, Section, Select, errorText, type Notice } from "./Field";

function fmtDate(iso: string | null) {
  return iso ? new Date(iso).toLocaleString("es-AR", { dateStyle: "medium", timeStyle: "short" }) : "—";
}

export function DataSettings({ onAuthError }: { onAuthError: (e: unknown) => boolean }) {
  const [stats, setStats] = useState<DataStats | null>(null);
  const [days, setDays] = useState(30);
  const [bucket, setBucket] = useState<"5m" | "15m" | "1h">("1h");
  const [purging, setPurging] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(() => api.dataStats().then(setStats).catch((e) => setNotice({ kind: "error", text: errorText(e) })), []);
  useEffect(() => {
    load();
  }, [load]);

  const purge = async () => {
    if (!stats || !window.confirm(`Se borrarán ${fmtInt(stats.metrics_simulated)} registros de métricas y ${fmtInt(stats.visits_simulated)} visitas simuladas. Los datos de cámara no se tocan. ¿Continuar?`)) return;
    setPurging(true);
    try {
      const r = await api.purgeSimulated();
      setNotice({ kind: "ok", text: `Borrados ${fmtInt(r.metrics_deleted)} registros y ${fmtInt(r.visits_deleted)} visitas simuladas.` });
      await load();
    } catch (e) {
      if (!onAuthError(e)) setNotice({ kind: "error", text: errorText(e) });
    } finally {
      setPurging(false);
    }
  };

  const rows: [string, number | undefined, number | undefined][] = [
    ["Registros de métricas", stats?.metrics_camera, stats?.metrics_simulated],
    ["Visitas", stats?.visits_camera, stats?.visits_simulated],
  ];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Section title="Datos almacenados" description={`Desde ${fmtDate(stats?.oldest ?? null)} hasta ${fmtDate(stats?.newest ?? null)} · ${fmtInt(stats?.alerts ?? 0)} alertas`}>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left">
              <th className="label pb-2 font-normal">Tipo</th>
              <th className="label pb-2 text-right font-normal">Cámara</th>
              <th className="label pb-2 text-right font-normal">Simulados</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {rows.map(([k, real, sim]) => (
              <tr key={k}>
                <td className="py-2 text-zinc-300">{k}</td>
                <td className="py-2 text-right font-mono tabular-nums text-zinc-100">{fmtInt(real)}</td>
                <td className="py-2 text-right font-mono tabular-nums text-zinc-400">{fmtInt(sim)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-white/5 pt-4">
          <Button variant="danger" onClick={purge} busy={purging} disabled={!stats || stats.metrics_simulated + stats.visits_simulated === 0}>
            <Eraser className="h-4 w-4" aria-hidden /> Borrar datos simulados
          </Button>
          <span className="text-xs text-zinc-500">Hacelo al conectar la cámara real para que el historial refleje sólo el local.</span>
        </div>
        <div className="mt-3">
          <NoticeLine notice={notice} />
        </div>
      </Section>

      <Section title="Exportar a Excel" description="CSV con separador ; y coma decimal, listo para abrir en Excel o Google Sheets.">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Período" htmlFor="days">
            <Select id="days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>Últimos 7 días</option>
              <option value={30}>Últimos 30 días</option>
              <option value={90}>Últimos 90 días</option>
              <option value={365}>Último año</option>
            </Select>
          </Field>
          <Field label="Agrupar por" htmlFor="bucket">
            <Select id="bucket" value={bucket} onChange={(e) => setBucket(e.target.value as typeof bucket)}>
              <option value="1h">Hora</option>
              <option value="15m">15 minutos</option>
              <option value="5m">5 minutos</option>
            </Select>
          </Field>
        </div>
        <a
          href={exportCsvUrl(days, bucket)}
          className="mt-5 inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-2 text-sm font-medium text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.06]"
          download
        >
          <Download className="h-4 w-4" aria-hidden /> Descargar CSV
        </a>
      </Section>
    </div>
  );
}

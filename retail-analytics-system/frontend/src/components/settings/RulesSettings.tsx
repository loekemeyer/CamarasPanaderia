import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { RulesSettings as Rules } from "../../lib/types";
import { Button, Field, NoticeLine, NumberInput, Section, errorText, type Notice } from "./Field";

type Key = keyof Rules;
interface RuleDef {
  key: Key;
  label: string;
  unit: string;
  hint: string;
  step?: number;
  /** Se muestra en minutos pero se guarda en segundos. */
  minutes?: boolean;
}

const GROUPS: { title: string; description: string; rules: RuleDef[] }[] = [
  {
    title: "Fila de caja",
    description: "Definen cuándo la fila se considera cargada.",
    rules: [
      { key: "queue_capacity", label: "Capacidad de la fila", unit: "pers.", hint: "Se usa si la zona de fila no tiene capacidad propia." },
      { key: "queue_target_wait_s", label: "Espera objetivo", unit: "min", minutes: true, step: 0.5, hint: "Espera aceptable por cliente. El doble dispara alerta de espera prolongada." },
      { key: "max_occupancy", label: "Ocupación de referencia", unit: "pers.", hint: "Personas en el local que representan el 100 % de ocupación." },
    ],
  },
  {
    title: "Alertas",
    description: "Cuándo avisar y cada cuánto repetir.",
    rules: [
      { key: "accumulation_alert_threshold", label: "Umbral del índice", unit: "/100", hint: "Por encima de este valor empieza a contar para alertar." },
      { key: "accumulation_alert_sustain_s", label: "Sostenido durante", unit: "s", hint: "Evita alertas por picos de pocos segundos." },
      { key: "alert_cooldown_s", label: "Pausa entre alertas", unit: "min", minutes: true, step: 1, hint: "Tiempo mínimo antes de repetir una alerta del mismo tipo." },
    ],
  },
  {
    title: "Seguimiento de personas",
    description: "Ajuste fino del conteo. Cambialos sólo si ves conteos dobles o personas perdidas.",
    rules: [
      { key: "min_visit_seconds", label: "Permanencia mínima", unit: "s", step: 0.5, hint: "Detecciones más cortas no cuentan como ingreso (filtra reflejos y personas que pasan por la vereda)." },
      { key: "track_exit_timeout_s", label: "Tiempo para dar salida", unit: "s", step: 0.5, hint: "Subilo (5-8 s) si hay góndolas altas que tapan a los clientes." },
    ],
  },
];

export function RulesSettings({ onAuthError }: { onAuthError: (e: unknown) => boolean }) {
  const [rules, setRules] = useState<Rules | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    api.rules().then(setRules).catch((e) => setNotice({ kind: "error", text: errorText(e) }));
  }, []);

  if (!rules) return <div className="card h-64 animate-pulse" />;

  const save = async () => {
    const invalid = (Object.keys(rules) as Key[]).find((k) => !Number.isFinite(rules[k]));
    if (invalid) {
      setNotice({ kind: "error", text: "Hay campos vacíos." });
      return;
    }
    setSaving(true);
    try {
      setRules(await api.saveRules(rules));
      setNotice({ kind: "ok", text: "Reglas aplicadas en vivo." });
    } catch (e) {
      if (!onAuthError(e)) setNotice({ kind: "error", text: errorText(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {GROUPS.map((g) => (
          <Section key={g.title} title={g.title} description={g.description}>
            <div className="flex flex-col gap-4">
              {g.rules.map((r) => {
                const raw = rules[r.key];
                const shown = r.minutes ? Math.round((raw / 60) * 10) / 10 : raw;
                return (
                  <Field key={r.key} label={r.label} hint={r.hint} htmlFor={r.key}>
                    <NumberInput
                      id={r.key}
                      unit={r.unit}
                      step={r.step ?? 1}
                      min={0}
                      value={shown}
                      onValue={(n) => setRules({ ...rules, [r.key]: r.minutes ? Math.round(n * 60) : n })}
                    />
                  </Field>
                );
              })}
            </div>
          </Section>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={save} busy={saving}>
          Guardar reglas
        </Button>
        <NoticeLine notice={notice} />
      </div>
    </div>
  );
}

import { Camera, Database, KeyRound, LogOut, Shapes, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { CameraSettings } from "../components/settings/CameraSettings";
import { DataSettings } from "../components/settings/DataSettings";
import { Button, NoticeLine, TextInput, errorText, type Notice } from "../components/settings/Field";
import { RulesSettings } from "../components/settings/RulesSettings";
import { ZoneEditor } from "../components/settings/ZoneEditor";
import { AuthError, adminSession, api } from "../lib/api";

export type SettingsTab = "camara" | "zonas" | "reglas" | "datos";

const TABS: { key: SettingsTab; label: string; Icon: typeof Camera }[] = [
  { key: "camara", label: "Cámara", Icon: Camera },
  { key: "zonas", label: "Zonas", Icon: Shapes },
  { key: "reglas", label: "Reglas", Icon: SlidersHorizontal },
  { key: "datos", label: "Datos", Icon: Database },
];

interface Props {
  tab: SettingsTab;
  onTab: (t: SettingsTab) => void;
  frameSize: [number, number] | null;
}

export function SettingsPage({ tab, onTab, frameSize }: Props) {
  const [required, setRequired] = useState<boolean | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState("");
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    api
      .authInfo()
      .then(async ({ required: req }) => {
        setRequired(req);
        if (!req) return setUnlocked(true);
        if (adminSession.get()) {
          try {
            await api.authCheck();
            setUnlocked(true);
          } catch {
            adminSession.clear();
          }
        }
      })
      .catch((e) => setNotice({ kind: "error", text: errorText(e) }));
  }, []);

  const unlock = async () => {
    setChecking(true);
    setNotice(null);
    adminSession.set(password);
    try {
      await api.authCheck();
      setUnlocked(true);
      setPassword("");
    } catch (e) {
      adminSession.clear();
      setNotice({ kind: "error", text: e instanceof AuthError ? "Clave incorrecta." : errorText(e) });
    } finally {
      setChecking(false);
    }
  };

  /** Devuelve true si el error era de autenticación (y bloquea la sección). */
  const onAuthError = useCallback((e: unknown) => {
    if (e instanceof AuthError) {
      adminSession.clear();
      setUnlocked(false);
      setNotice({ kind: "error", text: "La sesión de administración venció. Ingresá la clave de nuevo." });
      return true;
    }
    return false;
  }, []);

  if (required === null) return <div className="card h-64 animate-pulse" />;

  if (!unlocked) {
    return (
      <div className="mx-auto mt-10 max-w-sm">
        <form
          className="card flex flex-col gap-4 p-6"
          onSubmit={(e) => {
            e.preventDefault();
            unlock();
          }}
        >
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <KeyRound className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h2 className="text-base font-medium text-zinc-50">Configuración protegida</h2>
              <p className="text-xs text-zinc-500">Ingresá la clave de administración.</p>
            </div>
          </div>
          <TextInput type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Clave" />
          <Button type="submit" variant="primary" busy={checking} disabled={!password}>
            Ingresar
          </Button>
          <NoticeLine notice={notice} />
        </form>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-1 rounded-xl border border-white/5 bg-surface-card/80 p-1" aria-label="Secciones de configuración">
          {TABS.map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => onTab(key)}
              aria-current={tab === key ? "page" : undefined}
              className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm transition ${tab === key ? "bg-white/[0.07] text-zinc-50" : "text-zinc-400 hover:text-zinc-200"}`}
            >
              <Icon className={`h-4 w-4 ${tab === key ? "text-accent" : ""}`} aria-hidden />
              {label}
            </button>
          ))}
        </nav>
        {required && (
          <Button
            onClick={() => {
              adminSession.clear();
              setUnlocked(false);
            }}
          >
            <LogOut className="h-4 w-4" aria-hidden /> Salir
          </Button>
        )}
      </div>
      {notice && <NoticeLine notice={notice} />}
      {tab === "camara" && <CameraSettings onAuthError={onAuthError} />}
      {tab === "zonas" && <ZoneEditor onAuthError={onAuthError} frameSize={frameSize} />}
      {tab === "reglas" && <RulesSettings onAuthError={onAuthError} />}
      {tab === "datos" && <DataSettings onAuthError={onAuthError} />}
    </div>
  );
}

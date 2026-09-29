import type {
  Alert,
  CameraSettings,
  AutoConnectResult,
  CameraTestResult,
  ChannelThumb,
  DiscoveryResult,
  DataStats,
  HeatmapResponse,
  RulesSettings,
  SummaryResponse,
  SystemStatus,
  VideoFile,
  ZoneRecord,
} from "./types";

const BASE = import.meta.env.VITE_API_URL ?? "";
const ADMIN_KEY = "ra_admin_password";

export class AuthError extends Error {}

export const adminSession = {
  get(): string | null {
    try {
      return sessionStorage.getItem(ADMIN_KEY);
    } catch {
      return null;
    }
  },
  set(value: string) {
    try {
      sessionStorage.setItem(ADMIN_KEY, value);
    } catch {
      /* almacenamiento no disponible: la clave vive sólo en memoria */
    }
    memoryPassword = value;
  },
  clear() {
    try {
      sessionStorage.removeItem(ADMIN_KEY);
    } catch {
      /* noop */
    }
    memoryPassword = null;
  },
};
let memoryPassword: string | null = null;

function authHeaders(): Record<string, string> {
  const pw = adminSession.get() ?? memoryPassword;
  return pw ? { "X-Admin-Password": pw } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) throw new AuthError("Clave de administración requerida o incorrecta");
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* respuesta sin JSON */
    }
    throw new Error(detail || `Error ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const put = <T,>(path: string, body: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) });
const post = <T,>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  heatmap: (days = 28) => request<HeatmapResponse>(`/api/metrics/heatmap?days=${days}`),
  summary: () => request<SummaryResponse>("/api/metrics/summary"),
  alerts: (hours = 24) => request<Alert[]>(`/api/alerts?hours=${hours}&limit=20`),
  ackAlert: (id: number) => post<Alert>(`/api/alerts/${id}/ack`),

  authInfo: () => request<{ required: boolean }>("/api/config/auth"),
  authCheck: () => post<{ ok: boolean }>("/api/config/auth/check"),
  system: () => request<SystemStatus>("/api/config/system"),
  camera: () => request<CameraSettings>("/api/config/camera"),
  saveCamera: (c: CameraSettings) => put<CameraSettings>("/api/config/camera", c),
  testCamera: (video_source: string, rtsp_transport: "tcp" | "udp") =>
    post<CameraTestResult>("/api/config/camera/test", { video_source, rtsp_transport }),
  discover: (hint: string | null, subnets: string[] = []) => post<DiscoveryResult>("/api/config/discovery", { hint, subnets }),
  autoconnect: (body: { ip: string; user: string; password: string; brand: string | null; channel?: number; port?: number }) =>
    post<AutoConnectResult>("/api/config/camera/autoconnect", body),
  channels: (body: { ip: string; user: string; password: string; template: string; port?: number }) =>
    post<{ channels: ChannelThumb[] }>("/api/config/camera/channels", body),
  rules: () => request<RulesSettings>("/api/config/rules"),
  saveRules: (r: RulesSettings) => put<RulesSettings>("/api/config/rules", r),
  videos: () => request<VideoFile[]>("/api/config/videos"),
  deleteVideo: (name: string) => request<void>(`/api/config/videos/${encodeURIComponent(name)}`, { method: "DELETE" }),
  zones: () => request<ZoneRecord[]>("/api/config/zones"),
  createZone: (z: Omit<ZoneRecord, "id" | "camera_id" | "created_at" | "updated_at">) =>
    post<ZoneRecord>("/api/config/zones", z),
  updateZone: (id: number, z: Partial<ZoneRecord>) => put<ZoneRecord>(`/api/config/zones/${id}`, z),
  deleteZone: (id: number) => request<void>(`/api/config/zones/${id}`, { method: "DELETE" }),
  dataStats: () => request<DataStats>("/api/config/data/stats"),
  purgeSimulated: () => post<{ metrics_deleted: number; visits_deleted: number }>("/api/config/data/purge-simulated"),
};

/** Subida con progreso (fetch no expone progreso de upload). */
export function uploadVideo(file: File, onProgress: (pct: number) => void): Promise<VideoFile> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE}/api/config/videos`);
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      if (xhr.status === 401) return reject(new AuthError("Clave de administración requerida"));
      if (xhr.status >= 200 && xhr.status < 300) return resolve(JSON.parse(xhr.responseText) as VideoFile);
      let detail = xhr.statusText;
      try {
        detail = JSON.parse(xhr.responseText).detail ?? detail;
      } catch {
        /* noop */
      }
      reject(new Error(detail));
    };
    xhr.onerror = () => reject(new Error("Error de red durante la subida"));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

export const streamUrl = `${BASE}/api/stream/mjpeg`;
export const snapshotUrl = `${BASE}/api/stream/snapshot.jpg`;
export const exportCsvUrl = (days: number, bucket: "5m" | "15m" | "1h") =>
  `${BASE}/api/metrics/export.csv?days=${days}&bucket=${bucket}`;

export function wsUrl(path = "/ws/metrics"): string {
  const explicit = import.meta.env.VITE_WS_URL as string | undefined;
  if (explicit) return explicit;
  if (BASE) return BASE.replace(/^http/, "ws") + path;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

export type AccumulationLevel = "fluido" | "moderado" | "alto" | "critico";
export type SourceMode = "yolo" | "simulate" | "starting";

export type ZoneKind = "queue" | "area" | "service" | "staff";

export interface Zone {
  id: number;
  name: string;
  kind: ZoneKind;
  polygon: [number, number][];
  capacity: number | null;
}

export interface Track {
  track_id: number;
  bbox: [number, number, number, number];
  confidence: number;
  dwell_seconds: number;
  in_queue: boolean;
  queue_wait_seconds: number;
  confirmed: boolean;
  staff?: boolean;
  served?: boolean;
}

export interface HourlyBucket {
  hour: number;
  label: string;
  entries: number;
  exits: number;
  abandons?: number;
}

export interface DwellBucket {
  key: "lt3" | "b3_6" | "b6_10" | "gt10";
  label: string;
  count: number;
  percentage: number;
}

export interface DwellStats {
  total_visits: number;
  avg_seconds: number | null;
  median_seconds?: number | null;
  buckets: DwellBucket[];
}

export interface Alert {
  id: number | null;
  camera_id: string;
  created_at: string;
  kind: "accumulation" | "queue_overflow" | "long_wait" | string;
  severity: "critical" | "high" | "medium" | "low" | string;
  title: string;
  message: string;
  value: number | null;
  acknowledged: boolean;
  acknowledged_at: string | null;
}

export interface MetricsMessage {
  type: "metrics";
  camera_id: string;
  camera_name: string;
  ts: number;
  source_mode: SourceMode;
  stream_connected: boolean;
  has_video: boolean;
  frame_size: [number, number] | null;
  processing_fps: number;
  people_count: number;
  queue_length: number;
  queue_capacity: number;
  avg_queue_wait_seconds: number;
  max_queue_wait_seconds: number;
  accumulation: { score: number; level: AccumulationLevel };
  staff_count?: number;
  today: {
    date: string | null;
    entries: number;
    exits: number;
    abandons?: number;
    queued?: number;
    abandon_rate?: number | null;
    abandon_tracking?: boolean;
  };
  hourly: HourlyBucket[];
  dwell: DwellStats;
  zones: Zone[];
  alerts: Alert[];
}

export interface TracksMessage {
  type: "tracks";
  camera_id: string;
  ts: number;
  tracks: Track[];
}

export interface AlertMessage {
  type: "alert";
  camera_id: string;
  alert: Alert;
}

export interface HelloMessage {
  type: "hello";
  camera_id: string;
  camera_name: string;
}

export interface PongMessage {
  type: "pong";
  ts: number | null;
}

export type ServerMessage = MetricsMessage | TracksMessage | AlertMessage | HelloMessage | PongMessage;

export interface HeatmapCell {
  dow: number;
  hour: number;
  avg_entries: number;
  avg_people: number;
  avg_accumulation: number;
  intensity: number;
}

export interface HeatmapResponse {
  camera_id: string;
  days: number;
  max_avg_entries: number;
  cells: HeatmapCell[];
}

export interface SummaryResponse {
  camera_id: string;
  day: string;
  entries: number;
  exits: number;
  abandons?: number;
  peak_people: number;
  peak_queue: number;
  avg_accumulation: number | null;
  max_accumulation: number | null;
  avg_dwell_seconds: number | null;
  alerts: number;
}

// --- Configuración ----------------------------------------------------------
export type VisionMode = "auto" | "yolo" | "simulate";

export interface CameraSettings {
  camera_id?: string;
  camera_name: string;
  video_source: string;
  vision_mode: VisionMode;
  rtsp_transport: "tcp" | "udp";
  process_fps: number;
  yolo_confidence: number;
}

export interface CameraTestResult {
  ok: boolean;
  message: string;
  width: number | null;
  height: number | null;
  fps: number | null;
  elapsed_ms: number;
  snapshot: string | null;
}

export interface RulesSettings {
  queue_capacity: number;
  queue_target_wait_s: number;
  max_occupancy: number;
  accumulation_alert_threshold: number;
  accumulation_alert_sustain_s: number;
  alert_cooldown_s: number;
  min_visit_seconds: number;
  track_exit_timeout_s: number;
  abandon_min_queue_s: number;
  unattended_alert_s: number;
}

export interface NotificationSettings {
  telegram_enabled: boolean;
  telegram_bot_token: string;
  telegram_chat_id: string;
  notify_min_severity: "medium" | "high" | "critical";
  daily_summary_enabled: boolean;
  daily_summary_hour: number;
  status?: { active: boolean; last_error: string | null; last_sent_at: number | null };
}

export interface VideoFile {
  name: string;
  path: string;
  size_bytes: number;
  modified_at: number;
}

export interface ZoneRecord extends Zone {
  camera_id: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DataStats {
  metrics_camera: number;
  metrics_simulated: number;
  visits_camera: number;
  visits_simulated: number;
  alerts: number;
  oldest: string | null;
  newest: string | null;
}

export interface SystemStatus {
  database: { ready: boolean; timescale: boolean };
  redis_pubsub: boolean;
  websocket_clients: number;
  vision: {
    camera_id: string;
    camera_name: string;
    mode: SourceMode;
    video_source: string;
    connected: boolean;
    has_video: boolean;
    frame_size: [number, number] | null;
    processing_fps: number;
    active_tracks: number;
    started_at: string | null;
    last_error: string | null;
  };
}

// --- Asistente de conexión ------------------------------------------------------
export interface DiscoveredDevice {
  ip: string;
  ports: number[];
  brand: string | null;
  brand_label: string;
  onvif: boolean;
  rtsp: boolean;
  title: string | null;
}

export interface DiscoveryResult {
  subnets: string[];
  devices: DiscoveredDevice[];
}

export interface AutoConnectResult {
  ok: boolean;
  message?: string;
  brand?: string;
  brand_label?: string;
  template?: string;
  video_source?: string;
  result?: CameraTestResult;
  tried: { brand: string; template: string; ok: boolean; elapsed_ms: number }[];
}

export interface ChannelThumb {
  channel: number;
  video_source: string;
  snapshot: string;
  width: number;
  height: number;
}

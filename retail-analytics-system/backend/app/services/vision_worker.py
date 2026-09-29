"""Motor de Computer Vision.

Flujo por cuadro:
    fuente (YOLOv8 + ByteTrack sobre mp4/RTSP, o simulador) -> detecciones con track_id
    -> MetricsEngine (conteo, permanencia, fila, acumulación, alertas)
    -> publicación en Redis Pub/Sub (tracks ~5 Hz, métricas 1 Hz, alertas al instante)
    -> persistencia periódica en PostgreSQL/TimescaleDB.

El worker corre en un hilo dedicado porque OpenCV y la inferencia son bloqueantes;
FastAPI y los WebSockets permanecen en el event loop sin verse afectados.
"""
from __future__ import annotations

import logging
import math
import os
import random
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np

from app.config import Settings

logger = logging.getLogger(__name__)

BBox = tuple[float, float, float, float]  # x1, y1, x2, y2 normalizados (0-1)
Detection = tuple[int, BBox, float]  # track_id, bbox, confianza
Publisher = Callable[[str, dict[str, Any]], None]

DWELL_BUCKETS: list[tuple[str, str, float, float]] = [
    ("lt3", "< 3 min", 0.0, 180.0),
    ("b3_6", "3 - 6 min", 180.0, 360.0),
    ("b6_10", "6 - 10 min", 360.0, 600.0),
    ("gt10", "> 10 min", 600.0, math.inf),
]


def dwell_bucket_key(seconds: float) -> str:
    for key, _label, lo, hi in DWELL_BUCKETS:
        if lo <= seconds < hi:
            return key
    return DWELL_BUCKETS[-1][0]


def point_in_polygon(x: float, y: float, polygon: list[list[float]]) -> bool:
    """Ray casting sobre coordenadas normalizadas."""
    inside = False
    n = len(polygon)
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if (yi > y) != (yj > y):
            x_cross = (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi
            if x < x_cross:
                inside = not inside
        j = i
    return inside


def accumulation_level(score: float) -> str:
    if score < 35:
        return "fluido"
    if score < 60:
        return "moderado"
    if score < 80:
        return "alto"
    return "critico"


@dataclass
class ZoneDef:
    id: int
    name: str
    kind: str
    polygon: list[list[float]]
    capacity: int | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "polygon": self.polygon,
            "capacity": self.capacity,
        }


@dataclass
class TrackState:
    track_id: int
    first_seen: float
    last_seen: float
    bbox: BBox
    confidence: float
    confirmed: bool = False
    in_queue: bool = False
    queue_since: float | None = None
    queue_seconds: float = 0.0

    def current_queue_wait(self, ts: float) -> float:
        return ts - self.queue_since if self.in_queue and self.queue_since is not None else 0.0


# =============================================================================
# Motor de métricas (lógica pura, sin I/O)
# =============================================================================
class MetricsEngine:
    VISIBLE_WINDOW_S = 1.0
    SCORE_TAU_S = 3.0

    def __init__(self, cfg: Settings, zones: list[ZoneDef] | None = None) -> None:
        self.cfg = cfg
        self.tz = ZoneInfo(cfg.timezone)
        self.zones: list[ZoneDef] = zones or []
        self.tracks: dict[int, TrackState] = {}

        self.day: date | None = None
        self.hourly_entries = [0] * 24
        self.hourly_exits = [0] * 24
        self.dwell_counts = {k: 0 for k, *_ in DWELL_BUCKETS}
        self.dwell_sum = 0.0
        self.dwell_n = 0

        self.score = 0.0
        self._last_update_ts: float | None = None
        self.people_count = 0
        self.queue_length = 0
        self.avg_queue_wait = 0.0
        self.max_queue_wait = 0.0

        # Acumuladores del intervalo de persistencia.
        self._iv_start: float | None = None
        self._iv_samples = 0
        self._iv_people_sum = 0.0
        self._iv_people_max = 0
        self._iv_queue_sum = 0.0
        self._iv_queue_max = 0
        self._iv_score_sum = 0.0
        self._iv_entries = 0
        self._iv_exits = 0
        self._iv_dwell: list[float] = []
        self._iv_queue_waits: list[float] = []
        self.pending_visits: list[dict[str, Any]] = []

        # Alertas.
        self._above_threshold_since: float | None = None
        self._overflow_since: float | None = None
        self._last_alert_at: dict[str, float] = {}
        self.recent_alerts: deque[dict[str, Any]] = deque(maxlen=20)

    # ------------------------------------------------------------------ zonas
    def set_zones(self, zones: list[ZoneDef]) -> None:
        self.zones = zones

    @property
    def queue_zones(self) -> list[ZoneDef]:
        return [z for z in self.zones if z.kind == "queue"]

    @property
    def queue_capacity(self) -> int:
        caps = [z.capacity for z in self.queue_zones if z.capacity]
        return sum(caps) if caps else self.cfg.queue_capacity

    def _in_queue(self, bbox: BBox) -> bool:
        foot_x = (bbox[0] + bbox[2]) / 2.0
        foot_y = bbox[3]
        return any(point_in_polygon(foot_x, foot_y, z.polygon) for z in self.queue_zones)

    # ------------------------------------------------------------ bootstrap
    def bootstrap(
        self,
        day: date,
        hourly_entries: list[int],
        hourly_exits: list[int],
        dwell_counts: dict[str, int],
        dwell_sum: float,
        dwell_n: int,
        recent_alerts: list[dict[str, Any]],
    ) -> None:
        self.day = day
        self.hourly_entries = list(hourly_entries)
        self.hourly_exits = list(hourly_exits)
        self.dwell_counts = {k: int(dwell_counts.get(k, 0)) for k, *_ in DWELL_BUCKETS}
        self.dwell_sum = float(dwell_sum)
        self.dwell_n = int(dwell_n)
        self.recent_alerts.clear()
        for a in reversed(recent_alerts):
            self.recent_alerts.appendleft(a)

    # --------------------------------------------------------------- helpers
    def _local(self, ts: float) -> datetime:
        return datetime.fromtimestamp(ts, self.tz)

    def _rollover(self, ts: float) -> None:
        today = self._local(ts).date()
        if self.day != today:
            if self.day is not None:
                logger.info("Cambio de día %s -> %s: se reinician acumulados diarios", self.day, today)
            self.day = today
            self.hourly_entries = [0] * 24
            self.hourly_exits = [0] * 24
            self.dwell_counts = {k: 0 for k, *_ in DWELL_BUCKETS}
            self.dwell_sum = 0.0
            self.dwell_n = 0

    def _compute_raw_score(self, people: int, queue_len: int, avg_wait: float) -> float:
        q = min(queue_len / max(self.queue_capacity, 1), 1.0)
        w = min(avg_wait / max(self.cfg.queue_target_wait_s, 1.0), 1.0)
        o = min(people / max(self.cfg.max_occupancy, 1), 1.0)
        return 100.0 * (0.55 * q + 0.30 * w + 0.15 * o)

    def _finalize(self, st: TrackState, source: str) -> None:
        if st.in_queue and st.queue_since is not None:
            st.queue_seconds += st.last_seen - st.queue_since
            st.in_queue = False
            st.queue_since = None
        if not st.confirmed:
            return
        dwell = max(st.last_seen - st.first_seen, 0.0)
        local_end = self._local(st.last_seen)
        if self.day == local_end.date():
            self.hourly_exits[local_end.hour] += 1
            self.dwell_counts[dwell_bucket_key(dwell)] += 1
            self.dwell_sum += dwell
            self.dwell_n += 1
        self._iv_exits += 1
        self._iv_dwell.append(dwell)
        if st.queue_seconds > 0:
            self._iv_queue_waits.append(st.queue_seconds)
        self.pending_visits.append(
            {
                "camera_id": self.cfg.camera_id,
                "track_id": st.track_id,
                "source": source,
                "started_at": datetime.fromtimestamp(st.first_seen, timezone.utc),
                "ended_at": datetime.fromtimestamp(st.last_seen, timezone.utc),
                "dwell_seconds": round(dwell, 2),
                "queue_seconds": round(st.queue_seconds, 2),
            }
        )

    # ---------------------------------------------------------------- update
    def update(self, ts: float, detections: list[Detection], source: str = "camera") -> list[dict[str, Any]]:
        """Procesa un cuadro. Devuelve las alertas nuevas generadas."""
        self._rollover(ts)
        if self._iv_start is None:
            self._iv_start = ts

        for track_id, bbox, conf in detections:
            st = self.tracks.get(track_id)
            if st is None:
                st = TrackState(track_id=track_id, first_seen=ts, last_seen=ts, bbox=bbox, confidence=conf)
                self.tracks[track_id] = st
            st.last_seen = ts
            st.bbox = bbox
            st.confidence = conf

            in_q = self._in_queue(bbox)
            if in_q and not st.in_queue:
                st.in_queue = True
                st.queue_since = ts
            elif not in_q and st.in_queue:
                if st.queue_since is not None:
                    st.queue_seconds += ts - st.queue_since
                st.in_queue = False
                st.queue_since = None

            # Una entrada cuenta sólo cuando el track se sostiene (filtra falsos positivos).
            if not st.confirmed and ts - st.first_seen >= self.cfg.min_visit_seconds:
                st.confirmed = True
                local_start = self._local(st.first_seen)
                if self.day == local_start.date():
                    self.hourly_entries[local_start.hour] += 1
                self._iv_entries += 1

        for tid in [t for t, s in self.tracks.items() if ts - s.last_seen > self.cfg.track_exit_timeout_s]:
            self._finalize(self.tracks.pop(tid), source)

        visible = [s for s in self.tracks.values() if ts - s.last_seen <= self.VISIBLE_WINDOW_S]
        queued = [s for s in visible if s.in_queue]
        waits = [s.current_queue_wait(ts) for s in queued]
        self.people_count = len(visible)
        self.queue_length = len(queued)
        self.avg_queue_wait = float(np.mean(waits)) if waits else 0.0
        self.max_queue_wait = max(waits) if waits else 0.0

        raw = self._compute_raw_score(self.people_count, self.queue_length, self.avg_queue_wait)
        dt = 0.0 if self._last_update_ts is None else max(ts - self._last_update_ts, 0.0)
        alpha = 1.0 if self._last_update_ts is None else 1.0 - math.exp(-dt / self.SCORE_TAU_S)
        self.score = self.score + alpha * (raw - self.score)
        self._last_update_ts = ts

        self._iv_samples += 1
        self._iv_people_sum += self.people_count
        self._iv_people_max = max(self._iv_people_max, self.people_count)
        self._iv_queue_sum += self.queue_length
        self._iv_queue_max = max(self._iv_queue_max, self.queue_length)
        self._iv_score_sum += self.score

        return self._check_alerts(ts)

    # ---------------------------------------------------------------- alerts
    def _cooldown_ok(self, kind: str, ts: float) -> bool:
        last = self._last_alert_at.get(kind)
        return last is None or ts - last >= self.cfg.alert_cooldown_s

    def _emit(self, ts: float, kind: str, severity: str, title: str, message: str, value: float) -> dict[str, Any]:
        self._last_alert_at[kind] = ts
        alert = {
            "id": None,
            "camera_id": self.cfg.camera_id,
            "created_at": datetime.fromtimestamp(ts, timezone.utc).isoformat(),
            "kind": kind,
            "severity": severity,
            "title": title,
            "message": message,
            "value": round(value, 2),
            "acknowledged": False,
            "acknowledged_at": None,
        }
        self.recent_alerts.appendleft(alert)
        return alert

    def _check_alerts(self, ts: float) -> list[dict[str, Any]]:
        new: list[dict[str, Any]] = []
        thr = self.cfg.accumulation_alert_threshold

        if self.score >= thr:
            self._above_threshold_since = self._above_threshold_since or ts
            sustained = ts - self._above_threshold_since
            if sustained >= self.cfg.accumulation_alert_sustain_s and self._cooldown_ok("accumulation", ts):
                sev = "critical" if self.score >= 90 else "high"
                new.append(
                    self._emit(
                        ts,
                        "accumulation",
                        sev,
                        "Acumulación alta en caja",
                        f"Índice {self.score:.0f}/100 sostenido {sustained:.0f} s con "
                        f"{self.queue_length} personas en fila. Habilitar otra caja.",
                        self.score,
                    )
                )
        else:
            self._above_threshold_since = None

        cap = self.queue_capacity
        if self.queue_length > cap:
            self._overflow_since = self._overflow_since or ts
            if ts - self._overflow_since >= 10 and self._cooldown_ok("queue_overflow", ts):
                new.append(
                    self._emit(
                        ts,
                        "queue_overflow",
                        "high",
                        "Fila excede la capacidad",
                        f"{self.queue_length} personas en fila (capacidad {cap}).",
                        float(self.queue_length),
                    )
                )
        else:
            self._overflow_since = None

        long_wait = 2 * self.cfg.queue_target_wait_s
        if self.max_queue_wait >= long_wait and self._cooldown_ok("long_wait", ts):
            new.append(
                self._emit(
                    ts,
                    "long_wait",
                    "medium",
                    "Espera prolongada",
                    f"Un cliente lleva {self.max_queue_wait / 60:.1f} min en fila "
                    f"(objetivo {self.cfg.queue_target_wait_s / 60:.1f} min).",
                    self.max_queue_wait,
                )
            )
        return new

    # -------------------------------------------------------------- payloads
    def dwell_payload(self) -> dict[str, Any]:
        total = sum(self.dwell_counts.values())
        return {
            "total_visits": total,
            "avg_seconds": round(self.dwell_sum / self.dwell_n, 1) if self.dwell_n else None,
            "buckets": [
                {
                    "key": key,
                    "label": label,
                    "count": self.dwell_counts[key],
                    "percentage": round(100.0 * self.dwell_counts[key] / total, 2) if total else 0.0,
                }
                for key, label, *_ in DWELL_BUCKETS
            ],
        }

    def tracks_payload(self, ts: float) -> list[dict[str, Any]]:
        out = []
        for s in self.tracks.values():
            if ts - s.last_seen > self.VISIBLE_WINDOW_S:
                continue
            out.append(
                {
                    "track_id": s.track_id,
                    "bbox": [round(v, 4) for v in s.bbox],
                    "confidence": round(s.confidence, 3),
                    "dwell_seconds": round(ts - s.first_seen, 1),
                    "in_queue": s.in_queue,
                    "queue_wait_seconds": round(s.current_queue_wait(ts), 1),
                    "confirmed": s.confirmed,
                }
            )
        return out

    def metrics_payload(self, ts: float) -> dict[str, Any]:
        return {
            "people_count": self.people_count,
            "queue_length": self.queue_length,
            "queue_capacity": self.queue_capacity,
            "avg_queue_wait_seconds": round(self.avg_queue_wait, 1),
            "max_queue_wait_seconds": round(self.max_queue_wait, 1),
            "accumulation": {"score": round(self.score, 1), "level": accumulation_level(self.score)},
            "today": {
                "date": self.day.isoformat() if self.day else None,
                "entries": sum(self.hourly_entries),
                "exits": sum(self.hourly_exits),
            },
            "hourly": [
                {"hour": h, "label": f"{h:02d}:00", "entries": self.hourly_entries[h], "exits": self.hourly_exits[h]}
                for h in range(24)
            ],
            "dwell": self.dwell_payload(),
            "zones": [z.as_dict() for z in self.zones],
            "alerts": list(self.recent_alerts)[:10],
        }

    def drain_interval(self, ts: float, source: str) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
        """Devuelve la fila agregada del intervalo y las visitas cerradas, y reinicia acumuladores."""
        visits, self.pending_visits = self.pending_visits, []
        if self._iv_samples == 0 or self._iv_start is None:
            return None, visits
        n = self._iv_samples
        row = {
            "time": datetime.fromtimestamp(ts, timezone.utc),
            "camera_id": self.cfg.camera_id,
            "source": source,
            "interval_s": round(ts - self._iv_start, 2),
            "people_count": round(self._iv_people_sum / n, 2),
            "people_max": self._iv_people_max,
            "queue_length": round(self._iv_queue_sum / n, 2),
            "queue_max": self._iv_queue_max,
            "accumulation_score": round(self._iv_score_sum / n, 2),
            "entries": self._iv_entries,
            "exits": self._iv_exits,
            "avg_dwell_seconds": round(float(np.mean(self._iv_dwell)), 2) if self._iv_dwell else None,
            "avg_queue_wait_seconds": round(float(np.mean(self._iv_queue_waits)), 2)
            if self._iv_queue_waits
            else None,
        }
        self._iv_start = ts
        self._iv_samples = 0
        self._iv_people_sum = 0.0
        self._iv_people_max = 0
        self._iv_queue_sum = 0.0
        self._iv_queue_max = 0
        self._iv_score_sum = 0.0
        self._iv_entries = 0
        self._iv_exits = 0
        self._iv_dwell = []
        self._iv_queue_waits = []
        return row, visits


# =============================================================================
# Fuentes de detección
# =============================================================================
def open_capture(target: Any, is_webcam: bool, timeout_ms: int) -> Any:
    import cv2

    if is_webcam:
        return cv2.VideoCapture(target)
    params = [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, timeout_ms, cv2.CAP_PROP_READ_TIMEOUT_MSEC, timeout_ms]
    return cv2.VideoCapture(target, cv2.CAP_FFMPEG, params)


def probe_source(source: str, rtsp_transport: str, timeout_s: float) -> dict[str, Any]:
    """Abre la fuente, lee un cuadro y devuelve resolución, fps y un JPEG de muestra."""
    import base64

    import cv2

    started = time.time()
    src = source.strip()
    is_webcam = src.isdigit()
    if src.lower().startswith("rtsp"):
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = f"rtsp_transport;{rtsp_transport}"
    if not is_webcam and "://" not in src and not os.path.isfile(src):
        return {"ok": False, "message": f"No existe el archivo {src}", "elapsed_ms": 0}
    cap = open_capture(int(src) if is_webcam else src, is_webcam, int(timeout_s * 1000))
    try:
        if not cap.isOpened():
            return {
                "ok": False,
                "message": "No se pudo abrir la fuente. Revisá IP, puerto, usuario/clave y que RTSP esté habilitado.",
                "elapsed_ms": int((time.time() - started) * 1000),
            }
        ok, frame = cap.read()
        if not ok or frame is None:
            return {
                "ok": False,
                "message": "La conexión abrió pero no llegó ningún cuadro (probá el substream o transporte TCP).",
                "elapsed_ms": int((time.time() - started) * 1000),
            }
        h, w = frame.shape[:2]
        fps = cap.get(cv2.CAP_PROP_FPS)
        preview = frame
        if w > 960:
            preview = cv2.resize(frame, (960, int(h * 960 / w)), interpolation=cv2.INTER_AREA)
        _, buf = cv2.imencode(".jpg", preview, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
        return {
            "ok": True,
            "message": "Conexión correcta",
            "width": w,
            "height": h,
            "fps": round(fps, 2) if fps and fps < 240 else None,
            "elapsed_ms": int((time.time() - started) * 1000),
            "snapshot": "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode(),
        }
    finally:
        cap.release()


class FrameGrabber:
    """Lectura de video con soporte mp4 (loop, ritmo real) y streams en vivo (reconexión)."""

    def __init__(self, source: str, rtsp_transport: str, backoff_max_s: float, open_timeout_s: float = 8.0) -> None:
        import cv2

        self.cv2 = cv2
        self.open_timeout_ms = int(open_timeout_s * 1000)
        self.source = source
        self.backoff_max_s = backoff_max_s
        self.is_file = os.path.isfile(source)
        self.is_webcam = source.isdigit()
        if source.lower().startswith("rtsp"):
            os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = f"rtsp_transport;{rtsp_transport}"
        self.cap: Any = None
        self.native_fps = 25.0
        self.frame_size: tuple[int, int] | None = None
        self.connected = False

        self._lock = threading.Lock()
        self._latest: np.ndarray | None = None
        self._latest_seq = 0
        self._consumed_seq = 0
        self._stop = threading.Event()
        self._reader: threading.Thread | None = None
        self._file_next_ts = 0.0

    def _open(self) -> bool:
        cv2 = self.cv2
        target: Any = int(self.source) if self.is_webcam else self.source
        cap = open_capture(target, self.is_webcam, self.open_timeout_ms)
        if not cap.isOpened():
            cap.release()
            return False
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        fps = cap.get(cv2.CAP_PROP_FPS)
        self.native_fps = fps if fps and 1 <= fps <= 120 else 25.0
        self.cap = cap
        self.connected = True
        return True

    def start(self) -> None:
        if not self._open():
            raise RuntimeError(f"No se pudo abrir la fuente de video: {self.source}")
        if not self.is_file:
            self._reader = threading.Thread(target=self._live_reader, name="frame-reader", daemon=True)
            self._reader.start()

    def _live_reader(self) -> None:
        backoff = 1.0
        while not self._stop.is_set():
            if self.cap is None or not self.connected:
                logger.warning("Reconectando stream %s en %.0f s", self.source, backoff)
                if self._stop.wait(backoff):
                    return
                if self._open():
                    logger.info("Stream reconectado")
                    backoff = 1.0
                else:
                    backoff = min(backoff * 2, self.backoff_max_s)
                continue
            ok, frame = self.cap.read()
            if not ok or frame is None:
                self.connected = False
                self.cap.release()
                self.cap = None
                continue
            with self._lock:
                self._latest = frame
                self._latest_seq += 1

    def read(self, process_fps: float) -> np.ndarray | None:
        if self.is_file:
            return self._read_file(process_fps)
        with self._lock:
            if self._latest is None or self._latest_seq == self._consumed_seq:
                return None
            self._consumed_seq = self._latest_seq
            return self._latest

    def _read_file(self, process_fps: float) -> np.ndarray | None:
        # Salteamos cuadros para respetar el ritmo real del archivo.
        skip = max(int(round(self.native_fps / process_fps)) - 1, 0)
        for _ in range(skip):
            if not self.cap.grab():
                break
        ok, frame = self.cap.read()
        if not ok or frame is None:
            self.cap.set(self.cv2.CAP_PROP_POS_FRAMES, 0)
            ok, frame = self.cap.read()
            if not ok:
                self.connected = False
                return None
        return frame

    def stop(self) -> None:
        self._stop.set()
        if self._reader:
            self._reader.join(timeout=2)
        if self.cap is not None:
            self.cap.release()


class YoloSource:
    name = "yolo"

    def __init__(self, cfg: Settings) -> None:
        from ultralytics import YOLO

        self.cfg = cfg
        self.grabber = FrameGrabber(
            cfg.video_source, cfg.rtsp_transport, cfg.reconnect_backoff_max_s, cfg.stream_open_timeout_s
        )
        self.grabber.start()
        logger.info("Cargando modelo %s en %s", cfg.yolo_model, cfg.yolo_device)
        self.model = YOLO(cfg.yolo_model)

    @property
    def connected(self) -> bool:
        return self.grabber.connected

    def read(self) -> tuple[np.ndarray | None, list[Detection] | None]:
        frame = self.grabber.read(self.cfg.process_fps)
        if frame is None:
            return None, None
        results = self.model.track(
            frame,
            persist=True,
            classes=[0],  # COCO class_id 0 = persona
            conf=self.cfg.yolo_confidence,
            iou=self.cfg.yolo_iou,
            imgsz=self.cfg.yolo_imgsz,
            device=self.cfg.yolo_device,
            tracker=self.cfg.tracker_config,
            verbose=False,
        )
        detections: list[Detection] = []
        if results:
            boxes = results[0].boxes
            if boxes is not None and boxes.id is not None:
                ids = boxes.id.int().cpu().tolist()
                xyxyn = boxes.xyxyn.cpu().numpy()
                confs = boxes.conf.cpu().numpy()
                cls = boxes.cls.int().cpu().tolist()
                for tid, box, conf, c in zip(ids, xyxyn, confs, cls):
                    if c != 0:
                        continue
                    x1, y1, x2, y2 = (float(v) for v in box)
                    detections.append((int(tid), (x1, y1, x2, y2), float(conf)))
        return frame, detections

    def close(self) -> None:
        self.grabber.stop()


# --- Simulador ----------------------------------------------------------------
# Clientes por hora de una panadería típica (hora local).
HOURLY_ARRIVALS: dict[int, float] = {
    6: 18, 7: 42, 8: 64, 9: 48, 10: 32, 11: 36, 12: 58, 13: 52, 14: 26,
    15: 22, 16: 30, 17: 46, 18: 66, 19: 60, 20: 40, 21: 16,
}
WEEKDAY_FACTOR = {0: 0.95, 1: 0.9, 2: 0.95, 3: 1.0, 4: 1.1, 5: 1.3, 6: 0.85}


def arrivals_per_hour(local: datetime, floor: float = 0.0) -> float:
    base = HOURLY_ARRIVALS.get(local.hour, 0.0)
    nxt = HOURLY_ARRIVALS.get((local.hour + 1) % 24, 0.0)
    frac = local.minute / 60.0
    rate = (base * (1 - frac) + nxt * frac) * WEEKDAY_FACTOR[local.weekday()]
    return max(rate, floor)


@dataclass
class SimPerson:
    track_id: int
    x: float
    y: float
    state: str
    target: tuple[float, float]
    wants_queue: bool
    browse_until: float = 0.0
    service_until: float = 0.0
    phase: float = field(default_factory=lambda: random.uniform(0, math.tau))


class SimulatedSource:
    """Genera tracks sintéticos realistas (entrada, recorrido, fila, atención, salida)."""

    name = "simulate"
    DOOR = (0.10, 0.97)
    COUNTER = (0.80, 0.33)
    SPEED = 0.11  # unidades normalizadas por segundo
    SLOT_GAP = 0.055

    def __init__(self, cfg: Settings) -> None:
        self.cfg = cfg
        self.tz = ZoneInfo(cfg.timezone)
        self.people: list[SimPerson] = []
        self.queue: list[SimPerson] = []
        self.next_id = 1
        self.last_ts: float | None = None
        self.connected = True

    def _slot(self, i: int) -> tuple[float, float]:
        if i < 8:
            return (0.80, 0.36 + i * self.SLOT_GAP)
        return (0.66, 0.36 + (i - 8) * self.SLOT_GAP)

    def _spawn(self, ts: float) -> None:
        p = SimPerson(
            track_id=self.next_id,
            x=self.DOOR[0] + random.uniform(-0.02, 0.02),
            y=self.DOOR[1],
            state="walking_in",
            target=(random.uniform(0.08, 0.45), random.uniform(0.25, 0.85)),
            wants_queue=random.random() < 0.78,
        )
        self.next_id += 1
        self.people.append(p)

    def _move(self, p: SimPerson, dt: float) -> bool:
        dx, dy = p.target[0] - p.x, p.target[1] - p.y
        dist = math.hypot(dx, dy)
        step = self.SPEED * dt
        if dist <= step:
            p.x, p.y = p.target
            return True
        p.x += dx / dist * step
        p.y += dy / dist * step
        return False

    def _bbox(self, p: SimPerson, ts: float) -> BBox:
        h = 0.13 + 0.17 * p.y
        w = h * 0.42
        sway = 0.004 * math.sin(ts * 2.1 + p.phase)
        x = p.x + sway
        return (max(x - w / 2, 0.0), max(p.y - h, 0.0), min(x + w / 2, 1.0), min(p.y, 1.0))

    def _warmup(self, ts: float) -> None:
        # Arranca con el local ocupado según la demanda de la hora (ley de Little).
        rate_h = arrivals_per_hour(datetime.fromtimestamp(ts, self.tz), floor=20.0)
        for _ in range(int(round(rate_h / 60.0 * 4.5))):
            self._spawn(ts)
            p = self.people[-1]
            p.x, p.y = random.uniform(0.08, 0.45), random.uniform(0.25, 0.85)
            p.target = (p.x, p.y)
            p.state = "browsing"
            p.browse_until = ts + random.uniform(10, 240)

    def read(self) -> tuple[None, list[Detection]]:
        ts = time.time()
        if self.last_ts is None:
            self._warmup(ts)
        dt = 0.0 if self.last_ts is None else min(ts - self.last_ts, 1.0)
        self.last_ts = ts

        rate_h = arrivals_per_hour(datetime.fromtimestamp(ts, self.tz), floor=20.0)
        if random.random() < rate_h / 3600.0 * dt:
            for _ in range(random.choices([1, 2, 3], weights=[70, 22, 8])[0]):
                self._spawn(ts)

        for p in list(self.people):
            if p.state == "walking_in":
                if self._move(p, dt):
                    p.state = "browsing"
                    p.browse_until = ts + min(random.lognormvariate(math.log(140), 0.75), 1500)
            elif p.state == "browsing":
                if random.random() < 0.02:
                    p.target = (
                        min(max(p.x + random.uniform(-0.05, 0.05), 0.06), 0.46),
                        min(max(p.y + random.uniform(-0.04, 0.04), 0.22), 0.88),
                    )
                self._move(p, dt)
                if ts >= p.browse_until:
                    if p.wants_queue:
                        p.state = "queued"
                        self.queue.append(p)
                    else:
                        p.state = "leaving"
                        p.target = self.DOOR
            elif p.state == "queued":
                p.target = self._slot(self.queue.index(p))
                self._move(p, dt)
                if self.queue and self.queue[0] is p and math.hypot(p.x - p.target[0], p.y - p.target[1]) < 0.01:
                    p.state = "serving"
                    p.service_until = ts + random.uniform(20, 60)
            elif p.state == "serving":
                p.target = self._slot(0)
                self._move(p, dt)
                if ts >= p.service_until:
                    self.queue.remove(p)
                    p.state = "leaving"
                    p.target = (self.DOOR[0] + 0.06, self.DOOR[1] + 0.05)
            elif p.state == "leaving":
                if self._move(p, dt):
                    self.people.remove(p)

        detections = [
            (p.track_id, self._bbox(p, ts), round(random.uniform(0.72, 0.96), 3))
            for p in self.people
            if p.y < 1.0
        ]
        return None, detections

    def close(self) -> None:
        self.people.clear()
        self.queue.clear()


# =============================================================================
# Worker
# =============================================================================
class VisionWorker:
    def __init__(self, cfg: Settings, publish: Publisher) -> None:
        self.cfg = cfg
        self.publish = publish
        self.engine = MetricsEngine(cfg)
        self.source: YoloSource | SimulatedSource | None = None
        self.mode = "starting"

        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._reload_zones = threading.Event()
        self._restart_source = threading.Event()

        self._jpeg_lock = threading.Lock()
        self._latest_jpeg: bytes | None = None
        self._jpeg_seq = 0
        self.frame_size: tuple[int, int] | None = None

        self._rebootstrap = False
        self.started_at: float | None = None
        self.last_error: str | None = None
        self.processing_fps = 0.0
        self._fps_window: deque[float] = deque(maxlen=30)

    # ----------------------------------------------------------- ciclo vida
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="vision-worker", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
        if self.source:
            self.source.close()

    def request_zone_reload(self) -> None:
        self._reload_zones.set()

    def request_source_restart(self) -> None:
        """Reabre la fuente con la configuración vigente (cambio de cámara/modo desde la web)."""
        self._restart_source.set()

    def request_rebootstrap(self) -> None:
        self._rebootstrap = True

    def latest_jpeg(self) -> tuple[int, bytes | None]:
        with self._jpeg_lock:
            return self._jpeg_seq, self._latest_jpeg

    def status(self) -> dict[str, Any]:
        return {
            "camera_id": self.cfg.camera_id,
            "camera_name": self.cfg.camera_name,
            "mode": self.mode,
            "video_source": self._redacted_source(),
            "connected": bool(self.source and self.source.connected),
            "has_video": self._latest_jpeg is not None,
            "frame_size": list(self.frame_size) if self.frame_size else None,
            "processing_fps": round(self.processing_fps, 2),
            "active_tracks": len(self.engine.tracks),
            "started_at": datetime.fromtimestamp(self.started_at, timezone.utc).isoformat()
            if self.started_at
            else None,
            "last_error": self.last_error,
        }

    def _redacted_source(self) -> str:
        from app.services.runtime_config import mask_source

        return mask_source(self.cfg.video_source)

    # --------------------------------------------------------------- fuente
    def _open_source(self) -> YoloSource | SimulatedSource:
        mode = self.cfg.vision_mode
        if mode == "simulate":
            return SimulatedSource(self.cfg)
        backoff = 2.0
        while not self._stop.is_set():
            try:
                return YoloSource(self.cfg)
            except Exception as exc:
                self.last_error = f"{type(exc).__name__}: {exc}"
                if mode == "auto":
                    logger.warning("YOLO/stream no disponible (%s). Se usa el simulador.", self.last_error)
                    return SimulatedSource(self.cfg)
                logger.error("No se pudo iniciar YOLO: %s. Reintento en %.0f s", self.last_error, backoff)
                self._stop.wait(backoff)
                if self._restart_source.is_set():
                    # Llegó otra configuración desde la web: se atiende en el próximo ciclo.
                    return SimulatedSource(self.cfg)
                backoff = min(backoff * 2, self.cfg.reconnect_backoff_max_s)
        return SimulatedSource(self.cfg)

    def _switch_source(self) -> None:
        logger.info("Reabriendo fuente de video: %s (%s)", self._redacted_source(), self.cfg.vision_mode)
        # Se cierra lo pendiente del intervalo con la fuente anterior.
        self._persist(time.time())
        if self.source:
            self.source.close()
        self.engine.tracks.clear()
        with self._jpeg_lock:
            self._latest_jpeg = None
        self.last_error = None
        self.mode = "starting"
        self.source = self._open_source()
        self.mode = self.source.name
        self.frame_size = (1280, 720) if self.mode == "simulate" else None
        logger.info("Fuente activa en modo %s", self.mode)

    def _data_source(self) -> str:
        return "simulated" if self.mode == "simulate" else "camera"

    # ------------------------------------------------------------- base de datos
    def _load_zones(self) -> None:
        from app.database import SessionLocal, db_state
        from app.models.zones import Zone

        if not db_state["ready"]:
            if not self.engine.zones:
                self.engine.set_zones(
                    [
                        ZoneDef(0, "Fila de caja", "queue",
                                [[0.52, 0.30], [0.97, 0.30], [0.97, 0.78], [0.52, 0.78]], self.cfg.queue_capacity),
                    ]
                )
            return
        try:
            with SessionLocal() as db:
                rows = db.query(Zone).filter(Zone.camera_id == self.cfg.camera_id, Zone.active.is_(True)).all()
                self.engine.set_zones([ZoneDef(z.id, z.name, z.kind, z.polygon, z.capacity) for z in rows])
            logger.info("Zonas cargadas: %s", [z.name for z in self.engine.zones])
        except Exception:
            logger.exception("No se pudieron cargar las zonas")

    def _bootstrap_today(self) -> None:
        from app.database import SessionLocal, db_state
        from app.models.alerts import Alert
        from app.models.metrics import MetricSnapshot, Visit

        if not db_state["ready"]:
            return
        tz = ZoneInfo(self.cfg.timezone)
        now_local = datetime.now(tz)
        day_start = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
        day_end = day_start + timedelta(days=1)
        entries = [0] * 24
        exits = [0] * 24
        counts = {k: 0 for k, *_ in DWELL_BUCKETS}
        dwell_sum, dwell_n = 0.0, 0
        try:
            with SessionLocal() as db:
                rows = (
                    db.query(MetricSnapshot.time, MetricSnapshot.entries, MetricSnapshot.exits)
                    .filter(
                        MetricSnapshot.camera_id == self.cfg.camera_id,
                        MetricSnapshot.time >= day_start,
                        MetricSnapshot.time < day_end,
                    )
                    .all()
                )
                for t, e, x in rows:
                    h = t.astimezone(tz).hour
                    entries[h] += e
                    exits[h] += x
                for (d,) in (
                    db.query(Visit.dwell_seconds)
                    .filter(Visit.camera_id == self.cfg.camera_id, Visit.ended_at >= day_start, Visit.ended_at < day_end)
                    .all()
                ):
                    counts[dwell_bucket_key(d)] += 1
                    dwell_sum += d
                    dwell_n += 1
                alerts = (
                    db.query(Alert)
                    .filter(Alert.camera_id == self.cfg.camera_id)
                    .order_by(Alert.created_at.desc())
                    .limit(10)
                    .all()
                )
                recent = [
                    {
                        "id": a.id,
                        "camera_id": a.camera_id,
                        "created_at": a.created_at.isoformat(),
                        "kind": a.kind,
                        "severity": a.severity,
                        "title": a.title,
                        "message": a.message,
                        "value": a.value,
                        "acknowledged": a.acknowledged,
                        "acknowledged_at": a.acknowledged_at.isoformat() if a.acknowledged_at else None,
                    }
                    for a in alerts
                ]
            self.engine.bootstrap(now_local.date(), entries, exits, counts, dwell_sum, dwell_n, recent)
            logger.info("Estado del día restaurado: %s entradas, %s visitas", sum(entries), dwell_n)
        except Exception:
            logger.exception("No se pudo restaurar el estado del día")

    def _persist(self, ts: float) -> None:
        from app.database import SessionLocal, db_state
        from app.models.metrics import MetricSnapshot, Visit

        row, visits = self.engine.drain_interval(ts, self._data_source())
        if not db_state["ready"] or (row is None and not visits):
            return
        try:
            with SessionLocal() as db:
                if row is not None:
                    db.add(MetricSnapshot(**row))
                if visits:
                    db.add_all([Visit(**v) for v in visits])
                db.commit()
        except Exception as exc:
            self.last_error = f"persistencia: {exc}"
            logger.exception("Error al persistir métricas")

    def _persist_alert(self, alert: dict[str, Any]) -> None:
        from app.database import SessionLocal, db_state
        from app.models.alerts import Alert

        if not db_state["ready"]:
            return
        try:
            with SessionLocal() as db:
                obj = Alert(
                    camera_id=alert["camera_id"],
                    created_at=datetime.fromisoformat(alert["created_at"]),
                    kind=alert["kind"],
                    severity=alert["severity"],
                    title=alert["title"],
                    message=alert["message"],
                    value=alert["value"],
                )
                db.add(obj)
                db.commit()
                alert["id"] = obj.id
        except Exception:
            logger.exception("Error al persistir alerta")

    # ----------------------------------------------------------------- video
    def _store_frame(self, frame: np.ndarray) -> None:
        import cv2

        h, w = frame.shape[:2]
        if w > self.cfg.stream_max_width:
            scale = self.cfg.stream_max_width / w
            frame = cv2.resize(frame, (self.cfg.stream_max_width, int(h * scale)), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), self.cfg.stream_jpeg_quality])
        if ok:
            with self._jpeg_lock:
                self._latest_jpeg = buf.tobytes()
                self._jpeg_seq += 1
            self.frame_size = (w, h)

    # ------------------------------------------------------------------ loop
    def _run(self) -> None:
        self.started_at = time.time()
        self._load_zones()
        self.source = self._open_source()
        self.mode = self.source.name
        if self.mode == "simulate":
            self.frame_size = (1280, 720)
            try:
                from app.services.demo_seed import seed_demo_history

                seed_demo_history(self.cfg)
            except Exception:
                logger.exception("No se pudo sembrar el historial demo")
        self._bootstrap_today()
        logger.info("Vision worker activo en modo %s", self.mode)

        period = 1.0 / self.cfg.process_fps
        tracks_period = 1.0 / max(self.cfg.tracks_publish_hz, 0.1)
        last_tracks = last_metrics = 0.0
        last_persist = time.time()

        while not self._stop.is_set():
            loop_start = time.time()
            try:
                if self._reload_zones.is_set():
                    self._reload_zones.clear()
                    self._load_zones()
                if self._rebootstrap:
                    self._rebootstrap = False
                    self._bootstrap_today()
                if self._restart_source.is_set():
                    self._restart_source.clear()
                    self._switch_source()

                frame, detections = self.source.read()
                ts = time.time()
                if detections is not None:
                    new_alerts = self.engine.update(ts, detections, self._data_source())
                    self._fps_window.append(ts)
                    if len(self._fps_window) >= 2:
                        span = self._fps_window[-1] - self._fps_window[0]
                        self.processing_fps = (len(self._fps_window) - 1) / span if span > 0 else 0.0
                    for alert in new_alerts:
                        self._persist_alert(alert)
                        self.publish("alerts", {"type": "alert", "camera_id": self.cfg.camera_id, "alert": alert})
                if frame is not None:
                    self._store_frame(frame)

                if ts - last_tracks >= tracks_period:
                    last_tracks = ts
                    self.publish(
                        "tracks",
                        {
                            "type": "tracks",
                            "camera_id": self.cfg.camera_id,
                            "ts": ts,
                            "tracks": self.engine.tracks_payload(ts),
                        },
                    )
                if ts - last_metrics >= self.cfg.metrics_publish_interval_s:
                    last_metrics = ts
                    payload = {
                        "type": "metrics",
                        "camera_id": self.cfg.camera_id,
                        "camera_name": self.cfg.camera_name,
                        "ts": ts,
                        "source_mode": self.mode,
                        "stream_connected": bool(self.source.connected),
                        "has_video": self._latest_jpeg is not None,
                        "frame_size": list(self.frame_size) if self.frame_size else None,
                        "processing_fps": round(self.processing_fps, 2),
                        **self.engine.metrics_payload(ts),
                    }
                    self.publish("metrics", payload)
                if ts - last_persist >= self.cfg.metrics_persist_interval_s:
                    last_persist = ts
                    self._persist(ts)
            except Exception as exc:
                self.last_error = f"{type(exc).__name__}: {exc}"
                logger.exception("Error en el ciclo del vision worker")
                self._stop.wait(1.0)

            elapsed = time.time() - loop_start
            if elapsed < period:
                self._stop.wait(period - elapsed)

        self._persist(time.time())
        logger.info("Vision worker detenido")

"""Application settings loaded from environment variables / .env."""
from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- App -----------------------------------------------------------------
    app_name: str = "Retail Analytics"
    log_level: str = "INFO"
    cors_origins: str = "*"
    timezone: str = "America/Argentina/Buenos_Aires"

    # --- Infraestructura -----------------------------------------------------
    database_url: str = "postgresql+psycopg2://retail:retail@postgres:5432/retail"
    db_connect_retries: int = 30
    db_connect_retry_delay_s: float = 2.0
    redis_url: str = "redis://redis:6379/0"
    redis_channel_metrics: str = "retail:metrics"
    redis_channel_tracks: str = "retail:tracks"
    redis_channel_alerts: str = "retail:alerts"
    redis_latest_ttl_s: int = 30

    # --- Cámara --------------------------------------------------------------
    camera_id: str = "cam-01"
    camera_name: str = "Caja principal"
    # Ruta a mp4 local, URL rtsp://, http(s):// o índice de webcam ("0").
    video_source: str = "/data/sample.mp4"
    rtsp_transport: Literal["tcp", "udp"] = "tcp"
    reconnect_backoff_max_s: float = 30.0
    # auto: usa YOLO si el stream abre; si no, cae a simulación.
    vision_mode: Literal["auto", "yolo", "simulate"] = "auto"

    # --- YOLOv8 --------------------------------------------------------------
    yolo_model: str = "yolov8n.pt"
    yolo_confidence: float = 0.35
    yolo_iou: float = 0.5
    yolo_imgsz: int = 640
    yolo_device: str = "cpu"
    tracker_config: str = "bytetrack.yaml"
    process_fps: float = Field(default=8.0, gt=0)

    # --- Reglas de negocio ---------------------------------------------------
    track_exit_timeout_s: float = 3.0
    min_visit_seconds: float = 2.0
    queue_capacity: int = 8
    queue_target_wait_s: float = 180.0
    max_occupancy: int = 40
    accumulation_alert_threshold: int = 75
    accumulation_alert_sustain_s: int = 20
    alert_cooldown_s: int = 300

    # --- Publicación / persistencia -----------------------------------------
    metrics_publish_interval_s: float = 1.0
    tracks_publish_hz: float = 5.0
    metrics_persist_interval_s: float = 10.0
    stream_jpeg_quality: int = 70
    stream_max_width: int = 960
    stream_fps: float = 10.0

    # --- Configuración web -------------------------------------------------
    # Si se define, la web pide esta clave para guardar cambios de configuración.
    admin_password: str = ""
    videos_dir: str = "/data/videos"
    max_upload_mb: int = 4096
    stream_open_timeout_s: float = 8.0

    # --- Demo ----------------------------------------------------------------
    # Sólo se aplica en modo simulado y con la tabla de métricas vacía.
    seed_demo_history: bool = True
    seed_days: int = 28

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator


class CameraSettings(BaseModel):
    camera_name: str = Field(min_length=1, max_length=80)
    video_source: str = Field(min_length=1, max_length=500)
    vision_mode: Literal["auto", "yolo", "simulate"]
    rtsp_transport: Literal["tcp", "udp"]
    process_fps: float = Field(ge=1, le=30)
    yolo_confidence: float = Field(ge=0.05, le=0.95)

    @field_validator("video_source")
    @classmethod
    def strip(cls, v: str) -> str:
        return v.strip()


class CameraTest(BaseModel):
    video_source: str = Field(min_length=1, max_length=500)
    rtsp_transport: Literal["tcp", "udp"] = "tcp"


class CameraTestResult(BaseModel):
    ok: bool
    message: str
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    elapsed_ms: int
    snapshot: str | None = None  # data:image/jpeg;base64,...


class RulesSettings(BaseModel):
    queue_capacity: int = Field(ge=1, le=100)
    queue_target_wait_s: float = Field(ge=10, le=3600)
    max_occupancy: int = Field(ge=1, le=1000)
    accumulation_alert_threshold: int = Field(ge=10, le=100)
    accumulation_alert_sustain_s: int = Field(ge=0, le=600)
    alert_cooldown_s: int = Field(ge=10, le=7200)
    min_visit_seconds: float = Field(ge=0, le=60)
    track_exit_timeout_s: float = Field(ge=0.5, le=60)
    abandon_min_queue_s: float = Field(default=30, ge=5, le=1800)
    unattended_alert_s: float = Field(default=30, ge=5, le=1800)


class NotificationSettings(BaseModel):
    telegram_enabled: bool
    telegram_bot_token: str = Field(default="", max_length=200)
    telegram_chat_id: str = Field(default="", max_length=64)
    notify_min_severity: Literal["medium", "high", "critical"]
    daily_summary_enabled: bool
    daily_summary_hour: int = Field(ge=0, le=23)


class VideoFile(BaseModel):
    name: str
    path: str
    size_bytes: int
    modified_at: float


class DataStats(BaseModel):
    metrics_camera: int
    metrics_simulated: int
    visits_camera: int
    visits_simulated: int
    alerts: int
    oldest: str | None
    newest: str | None


class PurgeResult(BaseModel):
    metrics_deleted: int
    visits_deleted: int

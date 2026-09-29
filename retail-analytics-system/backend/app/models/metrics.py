from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, Float, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class MetricSnapshot(Base):
    """Agregado por intervalo (hypertable en TimescaleDB, PK compuesta con el tiempo)."""

    __tablename__ = "metrics"

    time: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    camera_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    source: Mapped[str] = mapped_column(String(16), default="camera", nullable=False)
    interval_s: Mapped[float] = mapped_column(Float, nullable=False)
    people_count: Mapped[float] = mapped_column(Float, nullable=False)
    people_max: Mapped[int] = mapped_column(Integer, nullable=False)
    queue_length: Mapped[float] = mapped_column(Float, nullable=False)
    queue_max: Mapped[int] = mapped_column(Integer, nullable=False)
    accumulation_score: Mapped[float] = mapped_column(Float, nullable=False)
    entries: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    exits: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    abandons: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    avg_dwell_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    avg_queue_wait_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)

    __table_args__ = (Index("ix_metrics_camera_time", "camera_id", "time"),)


class Visit(Base):
    """Una visita completa: un track_id desde su entrada hasta su salida."""

    __tablename__ = "visits"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    camera_id: Mapped[str] = mapped_column(String(64), nullable=False)
    track_id: Mapped[int] = mapped_column(Integer, nullable=False)
    source: Mapped[str] = mapped_column(String(16), default="camera", nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ended_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    dwell_seconds: Mapped[float] = mapped_column(Float, nullable=False)
    queue_seconds: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    served: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    abandoned: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")

    __table_args__ = (Index("ix_visits_camera_ended", "camera_id", "ended_at"),)

from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, Field


class HistoryPoint(BaseModel):
    time: datetime
    people_avg: float
    people_max: int
    queue_avg: float
    queue_max: int
    accumulation_avg: float
    accumulation_max: float
    entries: int
    exits: int


class HourlyPoint(BaseModel):
    hour: int = Field(ge=0, le=23)
    label: str
    entries: int
    exits: int
    people_avg: float
    queue_max: int


class DwellBucket(BaseModel):
    key: str
    label: str
    count: int
    percentage: float


class DwellBreakdown(BaseModel):
    total_visits: int
    avg_seconds: float | None
    median_seconds: float | None
    buckets: list[DwellBucket]


class HeatmapCell(BaseModel):
    dow: int = Field(ge=1, le=7, description="ISO: 1=lunes ... 7=domingo")
    hour: int = Field(ge=0, le=23)
    avg_entries: float
    avg_people: float
    avg_accumulation: float
    intensity: float = Field(ge=0, le=100)


class HeatmapOut(BaseModel):
    camera_id: str
    days: int
    max_avg_entries: float
    cells: list[HeatmapCell]


class SummaryOut(BaseModel):
    camera_id: str
    day: date
    entries: int
    exits: int
    abandons: int
    peak_people: int
    peak_queue: int
    avg_accumulation: float | None
    max_accumulation: float | None
    avg_dwell_seconds: float | None
    alerts: int

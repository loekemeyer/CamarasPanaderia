"""Endpoints de métricas históricas y en vivo."""
from __future__ import annotations

import csv
import io
import time
from datetime import date, datetime, timedelta
from statistics import median
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import settings
from app.database import db_state, get_db
from app.schemas.metrics import (
    DwellBreakdown,
    HeatmapCell,
    HeatmapOut,
    HistoryPoint,
    HourlyPoint,
    SummaryOut,
)
from app.services.vision_worker import DWELL_BUCKETS

router = APIRouter(prefix="/api/metrics", tags=["metrics"])

BUCKETS: dict[str, str] = {
    "1m": "1 minute",
    "5m": "5 minutes",
    "15m": "15 minutes",
    "1h": "1 hour",
}


def _require_db() -> None:
    if not db_state["ready"]:
        raise HTTPException(status_code=503, detail="Base de datos no disponible")


def _day_bounds(day: date) -> tuple[datetime, datetime]:
    tz = ZoneInfo(settings.timezone)
    start = datetime(day.year, day.month, day.day, tzinfo=tz)
    return start, start + timedelta(days=1)


def _today() -> date:
    return datetime.now(ZoneInfo(settings.timezone)).date()


@router.get("/live")
def live(request: Request) -> dict:
    """Última muestra publicada por el worker (misma forma que el mensaje WS `metrics`)."""
    worker = request.app.state.worker
    ts = time.time()
    return {
        "type": "metrics",
        "camera_id": settings.camera_id,
        "camera_name": settings.camera_name,
        "ts": ts,
        "source_mode": worker.mode,
        "stream_connected": bool(worker.source and worker.source.connected),
        "frame_size": list(worker.frame_size) if worker.frame_size else None,
        "processing_fps": round(worker.processing_fps, 2),
        **worker.engine.metrics_payload(ts),
    }


@router.get("/history", response_model=list[HistoryPoint])
def history(
    hours: int = Query(24, ge=1, le=24 * 31),
    bucket: Literal["1m", "5m", "15m", "1h"] = "5m",
    camera_id: str | None = None,
    db: Session = Depends(get_db),
) -> list[HistoryPoint]:
    """Serie temporal agregada de las últimas `hours` horas (por defecto 24 h)."""
    _require_db()
    rows = db.execute(
        text(
            """
            SELECT date_bin(CAST(:bucket AS interval), time, TIMESTAMPTZ '2000-01-01') AS bucket_time,
                   AVG(people_count)       AS people_avg,
                   MAX(people_max)         AS people_max,
                   AVG(queue_length)       AS queue_avg,
                   MAX(queue_max)          AS queue_max,
                   AVG(accumulation_score) AS acc_avg,
                   MAX(accumulation_score) AS acc_max,
                   SUM(entries)            AS entries,
                   SUM(exits)              AS exits
            FROM metrics
            WHERE camera_id = :camera_id AND time >= now() - make_interval(hours => :hours)
            GROUP BY 1
            ORDER BY 1
            """
        ),
        {"bucket": BUCKETS[bucket], "camera_id": camera_id or settings.camera_id, "hours": hours},
    ).all()
    return [
        HistoryPoint(
            time=r.bucket_time,
            people_avg=round(float(r.people_avg), 2),
            people_max=int(r.people_max),
            queue_avg=round(float(r.queue_avg), 2),
            queue_max=int(r.queue_max),
            accumulation_avg=round(float(r.acc_avg), 2),
            accumulation_max=round(float(r.acc_max), 2),
            entries=int(r.entries),
            exits=int(r.exits),
        )
        for r in rows
    ]


@router.get("/hourly", response_model=list[HourlyPoint])
def hourly(
    day: date | None = None,
    camera_id: str | None = None,
    db: Session = Depends(get_db),
) -> list[HourlyPoint]:
    """Volumen por hora (ingresos vs. finalizaciones) de un día local."""
    _require_db()
    start, end = _day_bounds(day or _today())
    rows = db.execute(
        text(
            """
            SELECT EXTRACT(HOUR FROM time AT TIME ZONE :tz)::int AS hour,
                   SUM(entries)      AS entries,
                   SUM(exits)        AS exits,
                   AVG(people_count) AS people_avg,
                   MAX(queue_max)    AS queue_max
            FROM metrics
            WHERE camera_id = :camera_id AND time >= :start AND time < :end
            GROUP BY 1
            """
        ),
        {"tz": settings.timezone, "camera_id": camera_id or settings.camera_id, "start": start, "end": end},
    ).all()
    by_hour = {r.hour: r for r in rows}
    out: list[HourlyPoint] = []
    for h in range(24):
        r = by_hour.get(h)
        out.append(
            HourlyPoint(
                hour=h,
                label=f"{h:02d}:00",
                entries=int(r.entries) if r else 0,
                exits=int(r.exits) if r else 0,
                people_avg=round(float(r.people_avg), 2) if r else 0.0,
                queue_max=int(r.queue_max) if r else 0,
            )
        )
    return out


@router.get("/dwell", response_model=DwellBreakdown)
def dwell(
    hours: int = Query(24, ge=1, le=24 * 31),
    camera_id: str | None = None,
    db: Session = Depends(get_db),
) -> DwellBreakdown:
    """Distribución del tiempo de permanencia en la ventana indicada."""
    _require_db()
    values = [
        float(v)
        for (v,) in db.execute(
            text(
                "SELECT dwell_seconds FROM visits "
                "WHERE camera_id = :camera_id AND ended_at >= now() - make_interval(hours => :hours)"
            ),
            {"camera_id": camera_id or settings.camera_id, "hours": hours},
        ).all()
    ]
    total = len(values)
    buckets = []
    for key, label, lo, hi in DWELL_BUCKETS:
        count = sum(1 for v in values if lo <= v < hi)
        buckets.append(
            {"key": key, "label": label, "count": count, "percentage": round(100.0 * count / total, 2) if total else 0.0}
        )
    return DwellBreakdown(
        total_visits=total,
        avg_seconds=round(sum(values) / total, 1) if total else None,
        median_seconds=round(median(values), 1) if total else None,
        buckets=buckets,
    )


@router.get("/heatmap", response_model=HeatmapOut)
def heatmap(
    days: int = Query(28, ge=7, le=180),
    camera_id: str | None = None,
    db: Session = Depends(get_db),
) -> HeatmapOut:
    """Matriz semanal (día ISO x hora) de exigencia: ingresos promedio por hora."""
    _require_db()
    cam = camera_id or settings.camera_id
    rows = db.execute(
        text(
            """
            WITH per_hour AS (
                SELECT date_trunc('hour', time AT TIME ZONE :tz) AS h,
                       SUM(entries)            AS entries,
                       AVG(people_count)       AS people,
                       AVG(accumulation_score) AS acc
                FROM metrics
                WHERE camera_id = :camera_id AND time >= now() - make_interval(days => :days)
                GROUP BY 1
            )
            SELECT EXTRACT(ISODOW FROM h)::int AS dow,
                   EXTRACT(HOUR FROM h)::int   AS hour,
                   AVG(entries) AS avg_entries,
                   AVG(people)  AS avg_people,
                   AVG(acc)     AS avg_acc
            FROM per_hour
            GROUP BY 1, 2
            """
        ),
        {"tz": settings.timezone, "camera_id": cam, "days": days},
    ).all()
    peak = max((float(r.avg_entries) for r in rows), default=0.0)
    by_key = {(r.dow, r.hour): r for r in rows}
    cells: list[HeatmapCell] = []
    for dow in range(1, 8):
        for hour in range(24):
            r = by_key.get((dow, hour))
            avg_e = float(r.avg_entries) if r else 0.0
            cells.append(
                HeatmapCell(
                    dow=dow,
                    hour=hour,
                    avg_entries=round(avg_e, 2),
                    avg_people=round(float(r.avg_people), 2) if r else 0.0,
                    avg_accumulation=round(float(r.avg_acc), 2) if r else 0.0,
                    intensity=round(100.0 * avg_e / peak, 2) if peak > 0 else 0.0,
                )
            )
    return HeatmapOut(camera_id=cam, days=days, max_avg_entries=round(peak, 2), cells=cells)


@router.get("/summary", response_model=SummaryOut)
def summary(
    day: date | None = None,
    camera_id: str | None = None,
    db: Session = Depends(get_db),
) -> SummaryOut:
    """Resumen diario: totales, picos y permanencia media."""
    _require_db()
    d = day or _today()
    start, end = _day_bounds(d)
    cam = camera_id or settings.camera_id
    params = {"camera_id": cam, "start": start, "end": end}
    m = db.execute(
        text(
            """
            SELECT COALESCE(SUM(entries), 0) AS entries,
                   COALESCE(SUM(exits), 0)   AS exits,
                   COALESCE(SUM(abandons), 0) AS abandons,
                   COALESCE(MAX(people_max), 0) AS peak_people,
                   COALESCE(MAX(queue_max), 0)  AS peak_queue,
                   AVG(accumulation_score) AS acc_avg,
                   MAX(accumulation_score) AS acc_max
            FROM metrics
            WHERE camera_id = :camera_id AND time >= :start AND time < :end
            """
        ),
        params,
    ).one()
    avg_dwell = db.execute(
        text(
            "SELECT AVG(dwell_seconds) FROM visits "
            "WHERE camera_id = :camera_id AND ended_at >= :start AND ended_at < :end"
        ),
        params,
    ).scalar()
    alerts = db.execute(
        text(
            "SELECT COUNT(*) FROM alerts "
            "WHERE camera_id = :camera_id AND created_at >= :start AND created_at < :end"
        ),
        params,
    ).scalar()
    return SummaryOut(
        camera_id=cam,
        day=d,
        entries=int(m.entries),
        exits=int(m.exits),
        abandons=int(m.abandons),
        peak_people=int(m.peak_people),
        peak_queue=int(m.peak_queue),
        avg_accumulation=round(float(m.acc_avg), 2) if m.acc_avg is not None else None,
        max_accumulation=round(float(m.acc_max), 2) if m.acc_max is not None else None,
        avg_dwell_seconds=round(float(avg_dwell), 1) if avg_dwell is not None else None,
        alerts=int(alerts or 0),
    )


@router.get("/export.csv")
def export_csv(
    days: int = Query(30, ge=1, le=365),
    bucket: Literal["5m", "15m", "1h"] = "1h",
    camera_id: str | None = None,
    db: Session = Depends(get_db),
) -> StreamingResponse:
    """Descarga de métricas agregadas para Excel (separador ';', coma decimal)."""
    _require_db()
    rows = db.execute(
        text(
            """
            SELECT date_bin(CAST(:bucket AS interval), time, TIMESTAMPTZ '2000-01-01') AS bucket_time,
                   SUM(entries) AS entries, SUM(exits) AS exits, SUM(abandons) AS abandons,
                   AVG(people_count) AS people_avg, MAX(people_max) AS people_max,
                   AVG(queue_length) AS queue_avg, MAX(queue_max) AS queue_max,
                   AVG(accumulation_score) AS acc_avg, MAX(accumulation_score) AS acc_max,
                   AVG(avg_dwell_seconds) AS dwell_avg, bool_or(source = 'simulated') AS simulated
            FROM metrics
            WHERE camera_id = :camera_id AND time >= now() - make_interval(days => :days)
            GROUP BY 1 ORDER BY 1
            """
        ),
        {"bucket": BUCKETS[bucket], "camera_id": camera_id or settings.camera_id, "days": days},
    ).all()
    tz = ZoneInfo(settings.timezone)

    def num(v: float | None, digits: int = 2) -> str:
        return "" if v is None else f"{float(v):.{digits}f}".replace(".", ",")

    buf = io.StringIO()
    buf.write("\ufeff")  # BOM para que Excel detecte UTF-8
    w = csv.writer(buf, delimiter=";")
    w.writerow(
        [
            "fecha_hora_local", "ingresos", "finalizaciones", "abandonos_fila", "personas_prom", "personas_max",
            "fila_prom", "fila_max", "indice_acumulacion_prom", "indice_acumulacion_max",
            "permanencia_prom_s", "origen",
        ]
    )
    for r in rows:
        w.writerow(
            [
                r.bucket_time.astimezone(tz).strftime("%Y-%m-%d %H:%M"),
                int(r.entries), int(r.exits), int(r.abandons), num(r.people_avg), int(r.people_max),
                num(r.queue_avg), int(r.queue_max), num(r.acc_avg), num(r.acc_max),
                num(r.dwell_avg, 1), "simulado" if r.simulated else "camara",
            ]
        )
    filename = f"metricas_{camera_id or settings.camera_id}_{days}d.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

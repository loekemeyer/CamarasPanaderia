"""Historial sintético para el modo demo (sólo con la tabla de métricas vacía)."""
from __future__ import annotations

import logging
import math
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import numpy as np
from sqlalchemy import insert

from app.config import Settings
from app.database import SessionLocal, db_state, engine
from app.models.metrics import MetricSnapshot, Visit
from app.services.vision_worker import arrivals_per_hour

logger = logging.getLogger(__name__)

STEP = timedelta(minutes=1)


def seed_demo_history(cfg: Settings) -> int:
    if not db_state["ready"] or not cfg.seed_demo_history:
        return 0
    with SessionLocal() as db:
        if db.query(MetricSnapshot.time).filter(MetricSnapshot.camera_id == cfg.camera_id).first():
            return 0

    tz = ZoneInfo(cfg.timezone)
    rng = np.random.default_rng(42)
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    t = now - timedelta(days=cfg.seed_days)
    metric_rows: list[dict] = []
    visit_rows: list[dict] = []
    track_id = 1_000_000

    while t < now:
        local = t.astimezone(tz)
        rate_h = arrivals_per_hour(local) * rng.uniform(0.8, 1.2)
        lam_min = rate_h / 60.0
        entries = int(rng.poisson(lam_min))
        exits = int(rng.poisson(lam_min))
        # Little: ocupación = tasa * permanencia media (~4,5 min)
        people = lam_min * 4.5 * rng.uniform(0.85, 1.15)
        rho = min(rate_h * 0.78 * 55.0 / 3600.0, 0.95)
        queue = rho / (1.0 - rho) if rho > 0 else 0.0
        wait = queue * 55.0
        q = min(queue / max(cfg.queue_capacity, 1), 1.0)
        w = min(wait / cfg.queue_target_wait_s, 1.0)
        o = min(people / max(cfg.max_occupancy, 1), 1.0)
        score = 100.0 * (0.55 * q + 0.30 * w + 0.15 * o) * rng.uniform(0.85, 1.15)

        dwells = [min(float(rng.lognormal(math.log(200), 0.7)), 2400.0) for _ in range(exits)]
        for d in dwells:
            track_id += 1
            visit_rows.append(
                {
                    "camera_id": cfg.camera_id,
                    "track_id": track_id,
                    "source": "simulated",
                    "started_at": t - timedelta(seconds=d),
                    "ended_at": t,
                    "dwell_seconds": round(d, 2),
                    "queue_seconds": round(max(wait * rng.uniform(0.5, 1.5), 0.0), 2),
                }
            )
        metric_rows.append(
            {
                "time": t,
                "camera_id": cfg.camera_id,
                "source": "simulated",
                "interval_s": 60.0,
                "people_count": round(people, 2),
                "people_max": int(math.ceil(people * 1.3)),
                "queue_length": round(queue, 2),
                "queue_max": int(math.ceil(queue * 1.4)),
                "accumulation_score": round(min(score, 100.0), 2),
                "entries": entries,
                "exits": exits,
                "avg_dwell_seconds": round(float(np.mean(dwells)), 2) if dwells else None,
                "avg_queue_wait_seconds": round(wait, 2) if wait > 0 else None,
            }
        )
        t += STEP

    with engine.begin() as conn:
        for i in range(0, len(metric_rows), 5000):
            conn.execute(insert(MetricSnapshot), metric_rows[i : i + 5000])
        for i in range(0, len(visit_rows), 5000):
            conn.execute(insert(Visit), visit_rows[i : i + 5000])
    logger.info("Historial demo sembrado: %s métricas, %s visitas", len(metric_rows), len(visit_rows))
    return len(metric_rows)

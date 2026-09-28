"""Pruebas del motor de métricas (sin Postgres, Redis ni YOLO)."""
from datetime import date, datetime
from zoneinfo import ZoneInfo

from app.config import Settings
from app.services.vision_worker import (
    MetricsEngine,
    ZoneDef,
    accumulation_level,
    dwell_bucket_key,
    point_in_polygon,
)

QUEUE = ZoneDef(1, "Fila", "queue", [[0.5, 0.0], [1.0, 0.0], [1.0, 1.0], [0.5, 1.0]], 4)
IN_QUEUE = (0.6, 0.2, 0.7, 0.6)
OUTSIDE = (0.1, 0.2, 0.2, 0.6)


def make_engine(**overrides) -> MetricsEngine:
    cfg = Settings(
        min_visit_seconds=2,
        track_exit_timeout_s=3,
        accumulation_alert_threshold=50,
        accumulation_alert_sustain_s=5,
        alert_cooldown_s=60,
        queue_target_wait_s=60,
        **overrides,
    )
    return MetricsEngine(cfg, [QUEUE])


def base_ts() -> float:
    return datetime(2026, 9, 28, 12, 0, tzinfo=ZoneInfo("America/Argentina/Buenos_Aires")).timestamp()


def test_point_in_polygon():
    poly = [[0, 0], [1, 0], [1, 1], [0, 1]]
    assert point_in_polygon(0.5, 0.5, poly)
    assert not point_in_polygon(1.5, 0.5, poly)


def test_dwell_buckets_and_levels():
    assert dwell_bucket_key(10) == "lt3"
    assert dwell_bucket_key(200) == "b3_6"
    assert dwell_bucket_key(400) == "b6_10"
    assert dwell_bucket_key(900) == "gt10"
    assert accumulation_level(10) == "fluido"
    assert accumulation_level(50) == "moderado"
    assert accumulation_level(70) == "alto"
    assert accumulation_level(95) == "critico"


def test_entry_exit_and_dwell():
    eng = make_engine()
    t0 = base_ts()
    for i in range(0, 241):
        eng.update(t0 + i, [(7, OUTSIDE, 0.9)])
    assert eng.hourly_entries[12] == 1
    # Desaparece y vence el timeout -> salida con 240 s de permanencia.
    eng.update(t0 + 245, [])
    assert eng.hourly_exits[12] == 1
    assert eng.dwell_counts["b3_6"] == 1
    row, visits = eng.drain_interval(t0 + 246, "camera")
    assert row is not None and row["entries"] == 1 and row["exits"] == 1
    assert len(visits) == 1 and visits[0]["dwell_seconds"] == 240


def test_short_tracks_are_ignored():
    eng = make_engine()
    t0 = base_ts()
    eng.update(t0, [(1, OUTSIDE, 0.5)])
    eng.update(t0 + 1, [(1, OUTSIDE, 0.5)])
    eng.update(t0 + 10, [])
    assert sum(eng.hourly_entries) == 0
    assert sum(eng.hourly_exits) == 0


def test_queue_accumulation_triggers_alert():
    eng = make_engine()
    t0 = base_ts()
    alerts = []
    people = [(i, IN_QUEUE, 0.9) for i in range(6)]
    for s in range(0, 130):
        alerts += eng.update(t0 + s, people)
    assert eng.queue_length == 6
    assert eng.score > 50
    kinds = {a["kind"] for a in alerts}
    assert "accumulation" in kinds
    assert "queue_overflow" in kinds
    assert "long_wait" in kinds
    # Cooldown: alertas del mismo tipo separadas al menos alert_cooldown_s (60 s).
    acc = [datetime.fromisoformat(a["created_at"]).timestamp() for a in alerts if a["kind"] == "accumulation"]
    assert len(acc) == 3
    assert all(b - a >= 60 for a, b in zip(acc, acc[1:]))


def test_day_rollover_resets_daily_counters():
    eng = make_engine()
    eng.bootstrap(date(2026, 9, 27), [5] * 24, [5] * 24, {"lt3": 3}, 100.0, 3, [])
    eng.update(base_ts(), [])
    assert sum(eng.hourly_entries) == 0
    assert eng.dwell_n == 0

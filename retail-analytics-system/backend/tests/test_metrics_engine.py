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


SERVICE = ZoneDef(2, "Atención", "service", [[0.5, 0.0], [1.0, 0.0], [1.0, 0.3], [0.5, 0.3]], None)
STAFF = ZoneDef(3, "Mostrador", "staff", [[0.0, 0.0], [0.3, 0.0], [0.3, 0.2], [0.0, 0.2]], None)
IN_SERVICE = (0.6, 0.0, 0.7, 0.25)
BEHIND_COUNTER = (0.05, 0.0, 0.15, 0.15)


def make_full_engine() -> MetricsEngine:
    eng = make_engine(abandon_min_queue_s=20, unattended_alert_s=10)
    eng.set_zones([QUEUE, SERVICE, STAFF])
    return eng


def test_staff_is_not_a_customer():
    eng = make_full_engine()
    t0 = base_ts()
    for i in range(0, 60):
        eng.update(t0 + i, [(50, BEHIND_COUNTER, 0.9), (1, OUTSIDE, 0.9)])
    assert eng.people_count == 1
    assert eng.staff_count == 1
    assert sum(eng.hourly_entries) == 1


def test_customer_that_later_goes_behind_counter_is_uncounted():
    eng = make_full_engine()
    t0 = base_ts()
    for i in range(0, 10):
        eng.update(t0 + i, [(9, OUTSIDE, 0.9)])
    assert sum(eng.hourly_entries) == 1
    eng.update(t0 + 11, [(9, BEHIND_COUNTER, 0.9)])
    assert sum(eng.hourly_entries) == 0
    eng.update(t0 + 20, [])
    assert sum(eng.hourly_exits) == 0


def test_abandonment_vs_served():
    eng = make_full_engine()
    t0 = base_ts()
    # #1 hace fila 40 s y se va sin pasar por atención -> abandono
    # #2 hace fila 40 s y pasa 5 s por atención -> atendido
    for i in range(0, 40):
        eng.update(t0 + i, [(1, IN_QUEUE, 0.9), (2, IN_QUEUE, 0.9), (60, BEHIND_COUNTER, 0.9)])
    for i in range(40, 46):
        eng.update(t0 + i, [(2, IN_SERVICE, 0.9), (60, BEHIND_COUNTER, 0.9)])
    eng.update(t0 + 60, [(60, BEHIND_COUNTER, 0.9)])
    assert sum(eng.hourly_abandons) == 1
    assert eng.queued_today == 2
    payload = eng.metrics_payload(t0 + 60)
    assert payload["today"]["abandon_rate"] == 50.0
    _, visits = eng.drain_interval(t0 + 61, "camera")
    by_id = {v["track_id"]: v for v in visits}
    assert by_id[1]["abandoned"] and not by_id[1]["served"]
    assert by_id[2]["served"] and not by_id[2]["abandoned"]


def test_unattended_counter_alert():
    eng = make_full_engine()
    t0 = base_ts()
    alerts = []
    for i in range(0, 20):
        alerts += eng.update(t0 + i, [(1, IN_QUEUE, 0.9), (2, IN_QUEUE, 0.9)])
    assert any(a["kind"] == "unattended" for a in alerts)

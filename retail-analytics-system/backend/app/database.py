"""PostgreSQL/TimescaleDB (SQLAlchemy) y Redis."""
from __future__ import annotations

import logging
import time
from collections.abc import Iterator

import redis
import redis.asyncio as aioredis
from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=10,
    future=True,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

# Estado de la base, completado por init_db().
db_state: dict[str, bool] = {"ready": False, "timescale": False}


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _wait_for_db() -> bool:
    for attempt in range(1, settings.db_connect_retries + 1):
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            return True
        except OperationalError as exc:
            logger.warning(
                "PostgreSQL no disponible (intento %s/%s): %s",
                attempt,
                settings.db_connect_retries,
                exc.orig,
            )
            time.sleep(settings.db_connect_retry_delay_s)
    return False


DEFAULT_ZONES: list[dict] = [
    {"name": "Fila de caja", "kind": "queue", "polygon": [[0.52, 0.30], [0.97, 0.30], [0.97, 0.78], [0.52, 0.78]], "capacity": None},
    {"name": "Salón", "kind": "area", "polygon": [[0.02, 0.10], [0.50, 0.10], [0.50, 0.98], [0.02, 0.98]], "capacity": None},
    {"name": "Punto de atención", "kind": "service", "polygon": [[0.68, 0.30], [0.93, 0.30], [0.93, 0.39], [0.68, 0.39]], "capacity": None},
    {"name": "Detrás del mostrador", "kind": "staff", "polygon": [[0.66, 0.02], [0.99, 0.02], [0.99, 0.17], [0.66, 0.17]], "capacity": None},
]


def _seed_zones() -> None:
    """Crea las zonas por defecto. Las de atención y personal (v2) se agregan una sola vez."""
    from app.models.settings import AppSetting
    from app.models.zones import Zone

    with SessionLocal() as db:
        existing = db.query(Zone).filter(Zone.camera_id == settings.camera_id).all()
        marker = db.get(AppSetting, "zones_v2_seeded")
        kinds = {z.kind for z in existing}
        to_add = [
            z
            for z in DEFAULT_ZONES
            if not existing or (marker is None and z["kind"] in ("service", "staff") and z["kind"] not in kinds)
        ]
        for z in to_add:
            cap = settings.queue_capacity if z["kind"] == "queue" else settings.max_occupancy if z["kind"] == "area" else None
            db.add(Zone(camera_id=settings.camera_id, name=z["name"], kind=z["kind"], polygon=z["polygon"], capacity=cap))
        if marker is None:
            db.add(AppSetting(key="zones_v2_seeded", value={"done": True}))
        db.commit()


def init_db() -> bool:
    """Crea tablas, habilita TimescaleDB si existe y siembra zonas por defecto."""
    from app import models  # noqa: F401  registra los modelos en Base.metadata

    if not _wait_for_db():
        logger.error("No se pudo conectar a PostgreSQL; el sistema sigue sin persistencia.")
        return False

    with engine.begin() as conn:
        try:
            conn.execute(text("CREATE EXTENSION IF NOT EXISTS timescaledb"))
            db_state["timescale"] = True
        except Exception as exc:  # extensión no instalada: Postgres plano
            logger.warning("TimescaleDB no disponible, se usa PostgreSQL estándar: %s", exc)

    Base.metadata.create_all(engine)

    # Migraciones livianas para bases creadas por versiones anteriores.
    with engine.begin() as conn:
        for ddl in (
            "ALTER TABLE metrics ADD COLUMN IF NOT EXISTS abandons integer NOT NULL DEFAULT 0",
            "ALTER TABLE visits ADD COLUMN IF NOT EXISTS served boolean NOT NULL DEFAULT false",
            "ALTER TABLE visits ADD COLUMN IF NOT EXISTS abandoned boolean NOT NULL DEFAULT false",
        ):
            conn.execute(text(ddl))

    if db_state["timescale"]:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "SELECT create_hypertable('metrics', 'time', if_not_exists => TRUE, "
                    "migrate_data => TRUE, chunk_time_interval => INTERVAL '1 day')"
                )
            )

    _seed_zones()

    db_state["ready"] = True
    logger.info("Base de datos lista (timescale=%s)", db_state["timescale"])
    return True


# --- Redis -------------------------------------------------------------------
redis_sync: redis.Redis = redis.Redis.from_url(
    settings.redis_url, socket_connect_timeout=2, socket_timeout=2, health_check_interval=30
)


def create_async_redis() -> aioredis.Redis:
    return aioredis.from_url(settings.redis_url, socket_connect_timeout=2, health_check_interval=30)

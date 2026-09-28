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


def init_db() -> bool:
    """Crea tablas, habilita TimescaleDB si existe y siembra zonas por defecto."""
    from app import models  # noqa: F401  registra los modelos en Base.metadata
    from app.models.zones import Zone

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

    if db_state["timescale"]:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "SELECT create_hypertable('metrics', 'time', if_not_exists => TRUE, "
                    "migrate_data => TRUE, chunk_time_interval => INTERVAL '1 day')"
                )
            )

    with SessionLocal() as db:
        if db.query(Zone).count() == 0:
            db.add_all(
                [
                    Zone(
                        camera_id=settings.camera_id,
                        name="Fila de caja",
                        kind="queue",
                        polygon=[[0.52, 0.30], [0.97, 0.30], [0.97, 0.78], [0.52, 0.78]],
                        capacity=settings.queue_capacity,
                    ),
                    Zone(
                        camera_id=settings.camera_id,
                        name="Salón",
                        kind="area",
                        polygon=[[0.02, 0.10], [0.50, 0.10], [0.50, 0.98], [0.02, 0.98]],
                        capacity=settings.max_occupancy,
                    ),
                ]
            )
            db.commit()

    db_state["ready"] = True
    logger.info("Base de datos lista (timescale=%s)", db_state["timescale"])
    return True


# --- Redis -------------------------------------------------------------------
redis_sync: redis.Redis = redis.Redis.from_url(
    settings.redis_url, socket_connect_timeout=2, socket_timeout=2, health_check_interval=30
)


def create_async_redis() -> aioredis.Redis:
    return aioredis.from_url(settings.redis_url, socket_connect_timeout=2, health_check_interval=30)

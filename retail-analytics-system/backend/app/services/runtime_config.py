"""Configuración en caliente: persiste en `app_settings` y se aplica sobre `settings`.

El worker y el motor de métricas leen `settings` en cada ciclo, así que los cambios
de reglas impactan en el acto; los de cámara requieren reabrir la fuente.
"""
from __future__ import annotations

import logging
import re
from typing import Any

from pydantic import BaseModel

from app.config import settings
from app.database import SessionLocal, db_state
from app.models.settings import AppSetting
from app.schemas.settings import CameraSettings, RulesSettings

logger = logging.getLogger(__name__)

MASK = "••••••"
SECTIONS: dict[str, type[BaseModel]] = {"camera": CameraSettings, "rules": RulesSettings}


def current(section: str) -> dict[str, Any]:
    model = SECTIONS[section]
    return {field: getattr(settings, field) for field in model.model_fields}


def _apply(values: dict[str, Any]) -> None:
    for k, v in values.items():
        setattr(settings, k, v)


def load_overrides() -> None:
    if not db_state["ready"]:
        return
    try:
        with SessionLocal() as db:
            for row in db.query(AppSetting).all():
                model = SECTIONS.get(row.key)
                if model is None:
                    continue
                merged = {**current(row.key), **row.value}
                _apply(model.model_validate(merged).model_dump())
        logger.info("Configuración web aplicada")
    except Exception:
        logger.exception("No se pudo cargar la configuración web; se usan variables de entorno")


def save(section: str, data: BaseModel) -> dict[str, Any]:
    values = data.model_dump()
    with SessionLocal() as db:
        row = db.get(AppSetting, section)
        if row is None:
            db.add(AppSetting(key=section, value=values))
        else:
            row.value = values
        db.commit()
    _apply(values)
    return values


# --- Credenciales RTSP -------------------------------------------------------
_QUERY_PW = re.compile(r"(password=)([^&]*)", re.IGNORECASE)


def _stored_password(src: str) -> str | None:
    m = _QUERY_PW.search(src)
    if m:
        return m.group(2)
    if "://" in src and "@" in src:
        creds = src.split("://", 1)[1].rsplit("@", 1)[0]
        if ":" in creds:
            return creds.split(":", 1)[1]
    return None


def mask_source(src: str) -> str:
    """rtsp://user:clave@host -> rtsp://user:••••••@host (también ?password=… de XMEye)."""
    out = src
    if "://" in out and "@" in out:
        scheme, rest = out.split("://", 1)
        creds, host = rest.rsplit("@", 1)
        if ":" in creds:
            out = f"{scheme}://{creds.split(':', 1)[0]}:{MASK}@{host}"
    return _QUERY_PW.sub(lambda m: m.group(1) + (MASK if m.group(2) else ""), out)


def unmask_source(new: str, stored: str) -> str:
    """Si el usuario no tocó la clave enmascarada, se conserva la guardada."""
    if MASK not in new:
        return new
    password = _stored_password(stored)
    if password is None:
        raise ValueError("La URL contiene la clave enmascarada pero no hay una clave guardada; escribila de nuevo.")
    return new.replace(MASK, password)

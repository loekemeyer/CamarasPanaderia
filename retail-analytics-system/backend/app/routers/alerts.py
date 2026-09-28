"""Endpoints de alertas operativas."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.config import settings
from app.database import db_state, get_db
from app.models.alerts import Alert
from app.schemas.alerts import AlertOut

router = APIRouter(prefix="/api/alerts", tags=["alerts"])


def _require_db() -> None:
    if not db_state["ready"]:
        raise HTTPException(status_code=503, detail="Base de datos no disponible")


@router.get("", response_model=list[AlertOut])
def list_alerts(
    hours: int = Query(24, ge=1, le=24 * 31),
    only_open: bool = False,
    limit: int = Query(50, ge=1, le=500),
    camera_id: str | None = None,
    db: Session = Depends(get_db),
) -> list[Alert]:
    _require_db()
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    q = db.query(Alert).filter(Alert.camera_id == (camera_id or settings.camera_id), Alert.created_at >= since)
    if only_open:
        q = q.filter(Alert.acknowledged.is_(False))
    return q.order_by(Alert.created_at.desc()).limit(limit).all()


@router.post("/{alert_id}/ack", response_model=AlertOut)
def acknowledge(alert_id: int, db: Session = Depends(get_db)) -> Alert:
    _require_db()
    alert = db.get(Alert, alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alerta inexistente")
    if not alert.acknowledged:
        alert.acknowledged = True
        alert.acknowledged_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(alert)
    return alert

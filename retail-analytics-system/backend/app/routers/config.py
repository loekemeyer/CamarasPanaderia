"""Configuración: zonas de la cámara y estado del sistema."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.config import settings
from app.database import db_state, get_db
from app.models.zones import Zone
from app.schemas.zones import ZoneCreate, ZoneOut, ZoneUpdate

router = APIRouter(prefix="/api/config", tags=["config"])


def _require_db() -> None:
    if not db_state["ready"]:
        raise HTTPException(status_code=503, detail="Base de datos no disponible")


@router.get("/system")
def system(request: Request) -> dict:
    ws = request.app.state.ws_manager
    return {
        "app_name": settings.app_name,
        "timezone": settings.timezone,
        "database": dict(db_state),
        "redis_pubsub": ws.redis_ok,
        "websocket_clients": ws.client_count,
        "vision": request.app.state.worker.status(),
        "rules": {
            "queue_capacity": settings.queue_capacity,
            "queue_target_wait_s": settings.queue_target_wait_s,
            "max_occupancy": settings.max_occupancy,
            "accumulation_alert_threshold": settings.accumulation_alert_threshold,
            "accumulation_alert_sustain_s": settings.accumulation_alert_sustain_s,
            "alert_cooldown_s": settings.alert_cooldown_s,
            "min_visit_seconds": settings.min_visit_seconds,
            "track_exit_timeout_s": settings.track_exit_timeout_s,
        },
    }


@router.get("/zones", response_model=list[ZoneOut])
def list_zones(camera_id: str | None = None, db: Session = Depends(get_db)) -> list[Zone]:
    _require_db()
    return db.query(Zone).filter(Zone.camera_id == (camera_id or settings.camera_id)).order_by(Zone.id).all()


@router.post("/zones", response_model=ZoneOut, status_code=201)
def create_zone(body: ZoneCreate, request: Request, db: Session = Depends(get_db)) -> Zone:
    _require_db()
    zone = Zone(
        camera_id=body.camera_id or settings.camera_id,
        name=body.name,
        kind=body.kind,
        polygon=body.polygon,
        capacity=body.capacity,
        active=body.active,
    )
    db.add(zone)
    db.commit()
    db.refresh(zone)
    request.app.state.worker.request_zone_reload()
    return zone


@router.put("/zones/{zone_id}", response_model=ZoneOut)
def update_zone(zone_id: int, body: ZoneUpdate, request: Request, db: Session = Depends(get_db)) -> Zone:
    _require_db()
    zone = db.get(Zone, zone_id)
    if zone is None:
        raise HTTPException(status_code=404, detail="Zona inexistente")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(zone, field, value)
    db.commit()
    db.refresh(zone)
    request.app.state.worker.request_zone_reload()
    return zone


@router.delete("/zones/{zone_id}", status_code=204)
def delete_zone(zone_id: int, request: Request, db: Session = Depends(get_db)) -> Response:
    _require_db()
    zone = db.get(Zone, zone_id)
    if zone is None:
        raise HTTPException(status_code=404, detail="Zona inexistente")
    db.delete(zone)
    db.commit()
    request.app.state.worker.request_zone_reload()
    return Response(status_code=204)

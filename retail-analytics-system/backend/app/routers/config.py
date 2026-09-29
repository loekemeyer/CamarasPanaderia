"""Configuración desde la web: cámara, zonas, reglas, videos de prueba y datos."""
from __future__ import annotations

import asyncio
import hmac
import os
import re
from pathlib import Path

from fastapi import APIRouter, Depends, File, Header, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import settings
from app.database import db_state, get_db
from app.models.zones import Zone
from app.schemas.settings import (
    CameraSettings,
    CameraTest,
    CameraTestResult,
    DataStats,
    PurgeResult,
    RulesSettings,
    VideoFile,
)
from app.schemas.zones import ZoneCreate, ZoneOut, ZoneUpdate
from app.services import discovery, runtime_config
from app.services.vision_worker import probe_source

router = APIRouter(prefix="/api/config", tags=["config"])

VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".webm"}
CHUNK = 4 * 1024 * 1024


def _require_db() -> None:
    if not db_state["ready"]:
        raise HTTPException(status_code=503, detail="Base de datos no disponible")


def require_admin(x_admin_password: str | None = Header(default=None)) -> None:
    """Protege las escrituras si ADMIN_PASSWORD está definido."""
    expected = settings.admin_password
    if not expected:
        return
    if not x_admin_password or not hmac.compare_digest(x_admin_password.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="Clave de administración incorrecta")


# --- Estado y acceso ---------------------------------------------------------
@router.get("/auth")
def auth_info() -> dict:
    return {"required": bool(settings.admin_password)}


@router.post("/auth/check", dependencies=[Depends(require_admin)])
def auth_check() -> dict:
    return {"ok": True}


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
        "rules": runtime_config.current("rules"),
    }


# --- Cámara ------------------------------------------------------------------
@router.get("/camera")
def get_camera() -> dict:
    values = runtime_config.current("camera")
    values["video_source"] = runtime_config.mask_source(values["video_source"])
    values["camera_id"] = settings.camera_id
    return values


@router.put("/camera", dependencies=[Depends(require_admin)])
def put_camera(body: CameraSettings, request: Request) -> dict:
    _require_db()
    try:
        body.video_source = runtime_config.unmask_source(body.video_source, settings.video_source)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    runtime_config.save("camera", body)
    request.app.state.worker.request_source_restart()
    return get_camera()


@router.post("/camera/test", response_model=CameraTestResult, dependencies=[Depends(require_admin)])
async def test_camera(body: CameraTest) -> CameraTestResult:
    try:
        source = runtime_config.unmask_source(body.video_source, settings.video_source)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    result = await asyncio.to_thread(probe_source, source, body.rtsp_transport, settings.stream_open_timeout_s)
    return CameraTestResult(**result)


# --- Asistente: búsqueda y conexión automática ------------------------------------
class DiscoveryRequest(BaseModel):
    hint: str | None = Field(default=None, max_length=64, description="IP con la que el navegador llegó al panel")
    subnets: list[str] = Field(default_factory=list, max_length=4)


class AutoConnectRequest(BaseModel):
    ip: str = Field(min_length=7, max_length=64)
    user: str = Field(default="admin", max_length=64)
    password: str = Field(default="", max_length=128)
    brand: str | None = None
    channel: int = Field(default=1, ge=1, le=64)
    port: int = Field(default=554, ge=1, le=65535)
    transport: str = Field(default="tcp", pattern="^(tcp|udp)$")


class ChannelsRequest(BaseModel):
    ip: str = Field(min_length=7, max_length=64)
    user: str = Field(default="admin", max_length=64)
    password: str = Field(default="", max_length=128)
    template: str = Field(min_length=1, max_length=200)
    port: int = Field(default=554, ge=1, le=65535)
    max_channels: int = Field(default=8, ge=1, le=32)


@router.post("/discovery", dependencies=[Depends(require_admin)])
async def discover_devices(body: DiscoveryRequest) -> dict:
    return await discovery.discover(body.hint, body.subnets)


@router.post("/camera/autoconnect", dependencies=[Depends(require_admin)])
async def camera_autoconnect(body: AutoConnectRequest) -> dict:
    return await asyncio.to_thread(
        discovery.autoconnect,
        body.ip.strip(),
        body.user,
        body.password,
        body.brand,
        body.channel,
        body.port,
        body.transport,
    )


@router.post("/camera/channels", dependencies=[Depends(require_admin)])
async def camera_channels(body: ChannelsRequest) -> dict:
    channels = await asyncio.to_thread(
        discovery.scan_channels, body.ip.strip(), body.user, body.password, body.template, body.max_channels, body.port
    )
    return {"channels": channels}


# --- Reglas ------------------------------------------------------------------
@router.get("/rules", response_model=RulesSettings)
def get_rules() -> dict:
    return runtime_config.current("rules")


@router.put("/rules", response_model=RulesSettings, dependencies=[Depends(require_admin)])
def put_rules(body: RulesSettings) -> dict:
    _require_db()
    return runtime_config.save("rules", body)


# --- Videos de prueba --------------------------------------------------------
def _videos_dir() -> Path:
    path = Path(settings.videos_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _safe_name(name: str) -> str:
    stem, ext = os.path.splitext(os.path.basename(name))
    if ext.lower() not in VIDEO_EXTENSIONS:
        raise HTTPException(status_code=415, detail=f"Formato no soportado. Usá {', '.join(sorted(VIDEO_EXTENSIONS))}")
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-.") or "video"
    return f"{stem[:80]}{ext.lower()}"


@router.get("/videos", response_model=list[VideoFile])
def list_videos() -> list[VideoFile]:
    try:
        folder = _videos_dir()
    except OSError:
        return []
    files = [p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in VIDEO_EXTENSIONS]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return [
        VideoFile(name=p.name, path=str(p), size_bytes=p.stat().st_size, modified_at=p.stat().st_mtime) for p in files
    ]


@router.post("/videos", response_model=VideoFile, status_code=201, dependencies=[Depends(require_admin)])
async def upload_video(file: UploadFile = File(...)) -> VideoFile:
    name = _safe_name(file.filename or "video.mp4")
    try:
        folder = _videos_dir()
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"No se puede escribir en {settings.videos_dir}: {exc}") from exc
    target = folder / name
    tmp = folder / f".{name}.part"
    limit = settings.max_upload_mb * 1024 * 1024
    written = 0
    try:
        with tmp.open("wb") as out:
            while chunk := await file.read(CHUNK):
                written += len(chunk)
                if written > limit:
                    raise HTTPException(status_code=413, detail=f"El archivo supera {settings.max_upload_mb} MB")
                out.write(chunk)
        tmp.replace(target)
    finally:
        if tmp.exists():
            tmp.unlink()
    st = target.stat()
    return VideoFile(name=target.name, path=str(target), size_bytes=st.st_size, modified_at=st.st_mtime)


@router.delete("/videos/{name}", status_code=204, dependencies=[Depends(require_admin)])
def delete_video(name: str) -> Response:
    target = _videos_dir() / _safe_name(name)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Video inexistente")
    if os.path.abspath(settings.video_source) == str(target.resolve()):
        raise HTTPException(status_code=409, detail="Ese video es la fuente activa; cambiá la fuente antes de borrarlo")
    target.unlink()
    return Response(status_code=204)


# --- Zonas -------------------------------------------------------------------
@router.get("/zones", response_model=list[ZoneOut])
def list_zones(camera_id: str | None = None, db: Session = Depends(get_db)) -> list[Zone]:
    _require_db()
    return db.query(Zone).filter(Zone.camera_id == (camera_id or settings.camera_id)).order_by(Zone.id).all()


@router.post("/zones", response_model=ZoneOut, status_code=201, dependencies=[Depends(require_admin)])
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


@router.put("/zones/{zone_id}", response_model=ZoneOut, dependencies=[Depends(require_admin)])
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


@router.delete("/zones/{zone_id}", status_code=204, dependencies=[Depends(require_admin)])
def delete_zone(zone_id: int, request: Request, db: Session = Depends(get_db)) -> Response:
    _require_db()
    zone = db.get(Zone, zone_id)
    if zone is None:
        raise HTTPException(status_code=404, detail="Zona inexistente")
    db.delete(zone)
    db.commit()
    request.app.state.worker.request_zone_reload()
    return Response(status_code=204)


# --- Datos -------------------------------------------------------------------
@router.get("/data/stats", response_model=DataStats)
def data_stats(db: Session = Depends(get_db)) -> DataStats:
    _require_db()
    cam = {"camera_id": settings.camera_id}
    m = db.execute(
        text(
            "SELECT COUNT(*) FILTER (WHERE source <> 'simulated') AS real, "
            "COUNT(*) FILTER (WHERE source = 'simulated') AS sim, MIN(time) AS oldest, MAX(time) AS newest "
            "FROM metrics WHERE camera_id = :camera_id"
        ),
        cam,
    ).one()
    v = db.execute(
        text(
            "SELECT COUNT(*) FILTER (WHERE source <> 'simulated') AS real, "
            "COUNT(*) FILTER (WHERE source = 'simulated') AS sim FROM visits WHERE camera_id = :camera_id"
        ),
        cam,
    ).one()
    alerts = db.execute(text("SELECT COUNT(*) FROM alerts WHERE camera_id = :camera_id"), cam).scalar()
    return DataStats(
        metrics_camera=m.real,
        metrics_simulated=m.sim,
        visits_camera=v.real,
        visits_simulated=v.sim,
        alerts=int(alerts or 0),
        oldest=m.oldest.isoformat() if m.oldest else None,
        newest=m.newest.isoformat() if m.newest else None,
    )


@router.post("/data/purge-simulated", response_model=PurgeResult, dependencies=[Depends(require_admin)])
def purge_simulated(request: Request, db: Session = Depends(get_db)) -> PurgeResult:
    """Borra sólo las filas sintéticas (source = 'simulated'); los datos de cámara no se tocan."""
    _require_db()
    cam = {"camera_id": settings.camera_id}
    metrics_deleted = db.execute(
        text("DELETE FROM metrics WHERE camera_id = :camera_id AND source = 'simulated'"), cam
    ).rowcount
    visits_deleted = db.execute(
        text("DELETE FROM visits WHERE camera_id = :camera_id AND source = 'simulated'"), cam
    ).rowcount
    db.commit()
    request.app.state.worker.request_rebootstrap()
    return PurgeResult(metrics_deleted=metrics_deleted, visits_deleted=visits_deleted)

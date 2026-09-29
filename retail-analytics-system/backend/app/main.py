"""FastAPI: REST + WebSocket en tiempo real para Retail Analytics."""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import db_state, init_db
from app.routers import alerts, config, metrics, stream
from app.services.notifier import notifier
from app.services.runtime_config import load_overrides
from app.services.vision_worker import VisionWorker
from app.services.websocket_mgr import manager

logging.basicConfig(
    level=settings.log_level.upper(),
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
logger = logging.getLogger("retail")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    await asyncio.to_thread(init_db)
    await asyncio.to_thread(load_overrides)
    await manager.start()
    worker = VisionWorker(settings, manager.publish, on_alert=notifier.on_alert)
    app.state.worker = worker
    app.state.ws_manager = manager
    app.state.notifier = notifier
    notifier.start()
    worker.start()
    logger.info("Retail Analytics listo")
    try:
        yield
    finally:
        await asyncio.to_thread(worker.stop)
        await asyncio.to_thread(notifier.stop)
        await manager.stop()


app = FastAPI(
    title=settings.app_name,
    version="1.0.0",
    description="Analítica de video en tiempo real para retail: conteo, permanencia, filas y acumulación.",
    lifespan=lifespan,
)

origins = settings.cors_origin_list
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials="*" not in origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(metrics.router)
app.include_router(alerts.router)
app.include_router(config.router)
app.include_router(stream.router)


@app.get("/api/health", tags=["system"])
def health() -> dict:
    worker: VisionWorker = app.state.worker
    return {
        "status": "ok",
        "database": db_state["ready"],
        "timescale": db_state["timescale"],
        "redis": manager.redis_ok,
        "vision_mode": worker.mode,
        "stream_connected": bool(worker.source and worker.source.connected),
        "websocket_clients": manager.client_count,
    }


@app.websocket("/ws/metrics")
async def ws_metrics(ws: WebSocket) -> None:
    await manager.connect(ws)
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if msg.get("type") == "ping":
                await ws.send_text(json.dumps({"type": "pong", "ts": msg.get("ts")}))
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("Error en WebSocket")
    finally:
        await manager.disconnect(ws)

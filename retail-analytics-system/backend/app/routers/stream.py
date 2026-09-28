"""Stream MJPEG del último cuadro procesado (sin overlays: el dashboard los dibuja)."""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import StreamingResponse

from app.config import settings

router = APIRouter(prefix="/api/stream", tags=["stream"])

BOUNDARY = "frame"


@router.get("/snapshot.jpg")
def snapshot(request: Request) -> Response:
    _seq, jpeg = request.app.state.worker.latest_jpeg()
    if jpeg is None:
        raise HTTPException(status_code=503, detail="Sin video disponible (modo simulado o cámara desconectada)")
    return Response(content=jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@router.get("/mjpeg")
async def mjpeg(request: Request) -> StreamingResponse:
    worker = request.app.state.worker
    if worker.latest_jpeg()[1] is None:
        raise HTTPException(status_code=503, detail="Sin video disponible (modo simulado o cámara desconectada)")

    async def frames() -> AsyncIterator[bytes]:
        last_seq = -1
        period = 1.0 / max(settings.stream_fps, 1.0)
        while not await request.is_disconnected():
            seq, jpeg = worker.latest_jpeg()
            if jpeg is not None and seq != last_seq:
                last_seq = seq
                yield (
                    f"--{BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: {len(jpeg)}\r\n\r\n".encode()
                    + jpeg
                    + b"\r\n"
                )
            await asyncio.sleep(period)

    return StreamingResponse(
        frames(),
        media_type=f"multipart/x-mixed-replace; boundary={BOUNDARY}",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )

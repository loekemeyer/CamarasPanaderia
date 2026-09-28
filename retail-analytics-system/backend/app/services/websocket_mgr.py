"""Gestor de conexiones WebSocket con broadcasting vía Redis Pub/Sub.

El vision worker (hilo) publica en Redis; cada réplica del backend se suscribe
y reenvía a sus clientes. Si Redis no está disponible, la publicación cae a un
despacho local en el event loop, de modo que el dashboard sigue en vivo.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import WebSocket

from app.config import settings
from app.database import create_async_redis, redis_sync

logger = logging.getLogger(__name__)

SEND_TIMEOUT_S = 2.0


class ConnectionManager:
    def __init__(self) -> None:
        self.connections: set[WebSocket] = set()
        self._lock = asyncio.Lock()
        self.loop: asyncio.AbstractEventLoop | None = None
        self._listener: asyncio.Task[None] | None = None
        self.redis_ok = False
        self.latest: dict[str, str] = {}
        self.channels = {
            "metrics": settings.redis_channel_metrics,
            "tracks": settings.redis_channel_tracks,
            "alerts": settings.redis_channel_alerts,
        }
        self._kind_by_channel = {v: k for k, v in self.channels.items()}

    # ------------------------------------------------------------ ciclo vida
    async def start(self) -> None:
        self.loop = asyncio.get_running_loop()
        self._listener = asyncio.create_task(self._listen(), name="redis-listener")

    async def stop(self) -> None:
        if self._listener:
            self._listener.cancel()
            try:
                await self._listener
            except asyncio.CancelledError:
                pass
        async with self._lock:
            conns = list(self.connections)
            self.connections.clear()
        for ws in conns:
            try:
                await ws.close(code=1001)
            except Exception:
                pass

    # ---------------------------------------------------------- conexiones
    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self.connections.add(ws)
        await ws.send_text(
            json.dumps({"type": "hello", "camera_id": settings.camera_id, "camera_name": settings.camera_name})
        )
        for kind in ("metrics", "tracks"):
            if kind in self.latest:
                await ws.send_text(self.latest[kind])
        logger.info("WebSocket conectado (%s clientes)", len(self.connections))

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self.connections.discard(ws)
        logger.info("WebSocket desconectado (%s clientes)", len(self.connections))

    @property
    def client_count(self) -> int:
        return len(self.connections)

    # ----------------------------------------------------------- broadcast
    async def _send(self, ws: WebSocket, data: str) -> WebSocket | None:
        try:
            await asyncio.wait_for(ws.send_text(data), timeout=SEND_TIMEOUT_S)
            return None
        except Exception:
            return ws

    async def broadcast(self, kind: str, data: str) -> None:
        if kind in ("metrics", "tracks"):
            self.latest[kind] = data
        async with self._lock:
            conns = list(self.connections)
        if not conns:
            return
        dead = [ws for ws in await asyncio.gather(*(self._send(ws, data) for ws in conns)) if ws is not None]
        if dead:
            async with self._lock:
                for ws in dead:
                    self.connections.discard(ws)
            logger.info("Se descartaron %s clientes sin respuesta", len(dead))

    # --------------------------------------------- publicación (desde hilos)
    def publish(self, kind: str, payload: dict[str, Any]) -> None:
        """Thread-safe. Llamado por el vision worker."""
        data = json.dumps(payload, default=str, separators=(",", ":"))
        channel = self.channels[kind]
        if self.redis_ok:
            try:
                redis_sync.publish(channel, data)
                if kind == "metrics":
                    redis_sync.set(
                        f"retail:latest:{settings.camera_id}", data, ex=settings.redis_latest_ttl_s
                    )
                return
            except Exception as exc:
                logger.warning("Fallo al publicar en Redis, se usa despacho local: %s", exc)
                self.redis_ok = False
        if self.loop is not None and not self.loop.is_closed():
            asyncio.run_coroutine_threadsafe(self.broadcast(kind, data), self.loop)

    # -------------------------------------------------------- suscripción
    async def _listen(self) -> None:
        backoff = 1.0
        while True:
            client = create_async_redis()
            pubsub = client.pubsub()
            try:
                await pubsub.subscribe(*self.channels.values())
                self.redis_ok = True
                backoff = 1.0
                logger.info("Suscripto a Redis Pub/Sub: %s", list(self.channels.values()))
                async for message in pubsub.listen():
                    if message.get("type") != "message":
                        continue
                    channel = message["channel"]
                    if isinstance(channel, bytes):
                        channel = channel.decode()
                    data = message["data"]
                    if isinstance(data, bytes):
                        data = data.decode()
                    kind = self._kind_by_channel.get(channel)
                    if kind:
                        await self.broadcast(kind, data)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.redis_ok = False
                logger.warning("Redis Pub/Sub no disponible (%s); reintento en %.0f s", exc, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)
            finally:
                try:
                    await pubsub.aclose()
                    await client.aclose()
                except Exception:
                    pass


manager = ConnectionManager()

"""Avisos por Telegram: alertas en el momento y resumen diario.

Telegram es gratis y no requiere servidor propio: el dueño crea un bot con
@BotFather, le escribe un mensaje y el sistema detecta el chat. Todo se envía
desde un hilo propio para no frenar el análisis de video.
"""
from __future__ import annotations

import json
import logging
import queue
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from html import escape
from typing import Any
from zoneinfo import ZoneInfo

from app.config import settings

logger = logging.getLogger(__name__)

API = "https://api.telegram.org/bot{token}/{method}"
SEVERITY_RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}
SEVERITY_ICON = {"medium": "🟡", "high": "🟠", "critical": "🔴"}
DAYS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]


class TelegramError(Exception):
    pass


def _call(token: str, method: str, payload: dict[str, Any] | None = None, timeout: float = 10.0) -> Any:
    if not token:
        raise TelegramError("Falta el token del bot")
    data = json.dumps(payload or {}).encode()
    req = urllib.request.Request(
        API.format(token=token, method=method), data=data, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        try:
            desc = json.loads(exc.read().decode()).get("description", str(exc))
        except Exception:
            desc = str(exc)
        if exc.code == 401:
            desc = "Token inválido: copialo de nuevo desde @BotFather"
        elif "chat not found" in desc.lower():
            desc = "Chat no encontrado: escribile un mensaje al bot y tocá Detectar chat"
        raise TelegramError(desc) from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise TelegramError(f"Sin conexión con Telegram: {exc}") from exc
    if not body.get("ok"):
        raise TelegramError(body.get("description", "Respuesta inválida de Telegram"))
    return body["result"]


def send_message(token: str, chat_id: str, text: str) -> None:
    _call(token, "sendMessage", {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True})


def bot_info(token: str) -> dict[str, Any]:
    me = _call(token, "getMe")
    return {"username": me.get("username"), "name": me.get("first_name")}


def detect_chats(token: str) -> list[dict[str, Any]]:
    """Chats que le escribieron al bot recientemente (privados y grupos)."""
    updates = _call(token, "getUpdates", {"limit": 50, "allowed_updates": ["message", "my_chat_member"]})
    chats: dict[str, dict[str, Any]] = {}
    for u in updates:
        msg = u.get("message") or u.get("my_chat_member") or {}
        chat = msg.get("chat")
        if not chat:
            continue
        title = chat.get("title") or " ".join(filter(None, [chat.get("first_name"), chat.get("last_name")])) or chat.get("username")
        chats[str(chat["id"])] = {"id": str(chat["id"]), "title": title or str(chat["id"]), "type": chat.get("type")}
    return list(chats.values())


def fmt_duration(seconds: float | None) -> str:
    if seconds is None:
        return "—"
    s = int(round(seconds))
    return f"{s // 60}:{s % 60:02d} min" if s >= 60 else f"{s} s"


def fmt_pct(v: float | None) -> str:
    return "—" if v is None else f"{v:.1f}".replace(".", ",") + " %"


def build_daily_summary(day: datetime | None = None) -> str:
    """Resumen del día desde la base (mismas cifras que el panel)."""
    from sqlalchemy import text

    from app.database import SessionLocal

    tz = ZoneInfo(settings.timezone)
    now = day or datetime.now(tz)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)
    params = {"camera_id": settings.camera_id, "start": start, "end": end, "tz": settings.timezone}
    with SessionLocal() as db:
        m = db.execute(
            text(
                """
                SELECT COALESCE(SUM(entries), 0) AS entries, COALESCE(SUM(exits), 0) AS exits,
                       COALESCE(SUM(abandons), 0) AS abandons, COALESCE(MAX(queue_max), 0) AS peak_queue,
                       MAX(accumulation_score) AS acc_max
                FROM metrics WHERE camera_id = :camera_id AND time >= :start AND time < :end
                """
            ),
            params,
        ).one()
        peak = db.execute(
            text(
                """
                SELECT EXTRACT(HOUR FROM time AT TIME ZONE :tz)::int AS h, SUM(entries) AS e
                FROM metrics WHERE camera_id = :camera_id AND time >= :start AND time < :end
                GROUP BY 1 ORDER BY 2 DESC LIMIT 1
                """
            ),
            params,
        ).first()
        v = db.execute(
            text(
                """
                SELECT AVG(dwell_seconds) AS dwell, COUNT(*) FILTER (WHERE queue_seconds >= :minq) AS queued
                FROM visits WHERE camera_id = :camera_id AND ended_at >= :start AND ended_at < :end
                """
            ),
            {**params, "minq": settings.abandon_min_queue_s},
        ).one()
        alerts = db.execute(
            text("SELECT COUNT(*) FROM alerts WHERE camera_id = :camera_id AND created_at >= :start AND created_at < :end"),
            params,
        ).scalar()

    rate = 100.0 * m.abandons / v.queued if v.queued else None
    lines = [
        f"<b>📊 Resumen del {DAYS[now.weekday()]} {now:%d/%m}</b> · {escape(settings.camera_name)}",
        "",
        f"Ingresos: <b>{int(m.entries)}</b> · Finalizados: {int(m.exits)}",
        f"Hora pico: <b>{peak.h:02d}:00</b> ({int(peak.e)} ingresos)" if peak and peak.e else "Hora pico: —",
        f"Fila máxima: {int(m.peak_queue)} personas · Índice máx.: {int(m.acc_max or 0)}/100",
        f"Abandonos de fila: <b>{int(m.abandons)}</b> ({fmt_pct(rate)} de quienes hicieron fila)",
        f"Permanencia promedio: {fmt_duration(v.dwell)}",
        f"Alertas: {int(alerts or 0)}",
    ]
    return "\n".join(lines)


def format_alert(alert: dict[str, Any]) -> str:
    icon = SEVERITY_ICON.get(alert.get("severity", ""), "⚪")
    ts = datetime.fromisoformat(alert["created_at"]).astimezone(ZoneInfo(settings.timezone))
    return (
        f"{icon} <b>{escape(alert['title'])}</b>\n{escape(alert['message'])}\n"
        f"<i>{escape(settings.camera_name)} · {ts:%H:%M}</i>"
    )


class Notifier:
    def __init__(self) -> None:
        self._queue: queue.Queue[str] = queue.Queue(maxsize=100)
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self.last_error: str | None = None
        self.last_sent_at: float | None = None

    @property
    def active(self) -> bool:
        return bool(settings.telegram_enabled and settings.telegram_bot_token and settings.telegram_chat_id)

    def start(self) -> None:
        self._stop.clear()
        for target, name in ((self._sender, "telegram-sender"), (self._scheduler, "daily-summary")):
            t = threading.Thread(target=target, name=name, daemon=True)
            t.start()
            self._threads.append(t)

    def stop(self) -> None:
        self._stop.set()
        for t in self._threads:
            t.join(timeout=2)

    def on_alert(self, alert: dict[str, Any]) -> None:
        """Llamado por el worker. Filtra por severidad mínima y encola."""
        if not self.active:
            return
        if SEVERITY_RANK.get(alert.get("severity", ""), 0) < SEVERITY_RANK[settings.notify_min_severity]:
            return
        try:
            self._queue.put_nowait(format_alert(alert))
        except queue.Full:
            logger.warning("Cola de avisos llena; se descarta una alerta")

    def _sender(self) -> None:
        while not self._stop.is_set():
            try:
                text = self._queue.get(timeout=1)
            except queue.Empty:
                continue
            for attempt in range(3):
                try:
                    send_message(settings.telegram_bot_token, settings.telegram_chat_id, text)
                    self.last_sent_at = time.time()
                    self.last_error = None
                    break
                except TelegramError as exc:
                    self.last_error = str(exc)
                    logger.warning("No se pudo enviar el aviso (intento %s): %s", attempt + 1, exc)
                    if self._stop.wait(5 * (attempt + 1)):
                        return

    # ------------------------------------------------------------ resumen
    def _last_summary_date(self) -> str | None:
        from app.database import SessionLocal, db_state
        from app.models.settings import AppSetting

        if not db_state["ready"]:
            return None
        with SessionLocal() as db:
            row = db.get(AppSetting, "notifications_state")
            return row.value.get("last_summary_date") if row else None

    def _mark_summary_sent(self, day: str) -> None:
        from app.database import SessionLocal
        from app.models.settings import AppSetting

        with SessionLocal() as db:
            row = db.get(AppSetting, "notifications_state")
            if row is None:
                db.add(AppSetting(key="notifications_state", value={"last_summary_date": day}))
            else:
                row.value = {**row.value, "last_summary_date": day}
            db.commit()

    def _scheduler(self) -> None:
        from app.database import db_state

        while not self._stop.wait(30):
            try:
                if not (self.active and settings.daily_summary_enabled and db_state["ready"]):
                    continue
                now = datetime.now(ZoneInfo(settings.timezone))
                if now.hour < settings.daily_summary_hour:
                    continue
                today = now.date().isoformat()
                if self._last_summary_date() == today:
                    continue
                send_message(settings.telegram_bot_token, settings.telegram_chat_id, build_daily_summary(now))
                self._mark_summary_sent(today)
                self.last_sent_at = time.time()
                logger.info("Resumen diario enviado")
            except TelegramError as exc:
                self.last_error = str(exc)
                logger.warning("No se pudo enviar el resumen diario: %s", exc)
            except Exception:
                logger.exception("Error en el programador del resumen diario")


notifier = Notifier()

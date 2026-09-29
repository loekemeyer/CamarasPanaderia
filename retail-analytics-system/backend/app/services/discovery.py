"""Descubrimiento de cámaras/NVR en la red local y conexión RTSP automática.

1. `discover()`: WS-Discovery (ONVIF, multicast) + escaneo TCP de puertos típicos
   de CCTV sobre la subred local. Estima la marca por puertos y por el banner HTTP.
2. `autoconnect()`: con IP + usuario + clave prueba las rutas RTSP conocidas
   (primero las de la marca estimada) hasta obtener un cuadro.
3. `scan_channels()`: en un NVR, prueba los canales 1..N y devuelve miniaturas
   para elegir la cámara que apunta a la caja.
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging
import re
import socket
import uuid
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

from app.services.vision_worker import probe_source

logger = logging.getLogger(__name__)

# puerto -> pista de marca
PORTS: dict[int, str | None] = {
    554: None,  # RTSP
    80: None,  # web
    8000: "hikvision",  # SDK Hikvision / HiLook / EZVIZ
    37777: "dahua",  # SDK Dahua / Imou
    34567: "xmeye",  # XMEye / iCSee (genéricas chinas)
    9000: "reolink",  # medios Reolink
    8899: "onvif",  # ONVIF en varias genéricas
}

BANNERS: list[tuple[str, str]] = [
    (r"hikvision|app-webs|dnvrs-webs|hik-?connect|isapi", "hikvision"),
    (r"dahua|dh-|web service|imou", "dahua"),
    (r"reolink", "reolink"),
    (r"uniview|unv", "uniview"),
    (r"ezviz", "ezviz"),
    (r"xmeye|netsurveillance|icsee|xiongmai", "xmeye"),
    (r"tapo|tp-link", "tapo"),
]

BRAND_LABELS = {
    "hikvision": "Hikvision / HiLook",
    "dahua": "Dahua / Imou",
    "reolink": "Reolink",
    "uniview": "Uniview",
    "ezviz": "EZVIZ",
    "xmeye": "XMEye / iCSee (genérica)",
    "tapo": "TP-Link Tapo",
    "onvif": "ONVIF genérica",
}

# Rutas RTSP por marca. {ch} = canal, {sub} = substream (preferido).
RTSP_TEMPLATES: dict[str, list[str]] = {
    "hikvision": ["/Streaming/Channels/{ch}02", "/Streaming/Channels/{ch}01", "/h264/ch{ch}/sub/av_stream"],
    "ezviz": ["/h264/ch{ch}/sub/av_stream", "/h264/ch{ch}/main/av_stream", "/Streaming/Channels/{ch}02"],
    "dahua": ["/cam/realmonitor?channel={ch}&subtype=1", "/cam/realmonitor?channel={ch}&subtype=0"],
    "reolink": ["/h264Preview_{ch:02d}_sub", "/h264Preview_{ch:02d}_main", "/Preview_{ch:02d}_sub"],
    "uniview": ["/unicast/c{ch}/s1/live", "/unicast/c{ch}/s0/live", "/media/video{ch}"],
    "xmeye": [
        "/user={user}&password={password}&channel={ch}&stream=1.sdp",
        "/user={user}&password={password}&channel={ch}&stream=0.sdp",
        "/12",
        "/11",
    ],
    "tapo": ["/stream2", "/stream1"],
    "onvif": ["/onvif1", "/live/ch{ch}", "/stream1", "/live", "/h264", "/1"],
}
BRAND_ORDER = ["hikvision", "dahua", "xmeye", "reolink", "uniview", "ezviz", "tapo", "onvif"]


@dataclass
class Device:
    ip: str
    ports: list[int] = field(default_factory=list)
    brand: str | None = None
    onvif: bool = False
    title: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "ip": self.ip,
            "ports": sorted(self.ports),
            "brand": self.brand,
            "brand_label": BRAND_LABELS.get(self.brand or "", "Desconocida"),
            "onvif": self.onvif,
            "rtsp": 554 in self.ports,
            "title": self.title,
        }


# --- Subredes ------------------------------------------------------------------
def _own_ipv4() -> list[str]:
    ips: set[str] = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return [ip for ip in ips if not ip.startswith("127.")]


def candidate_subnets(hint: str | None, extra: list[str]) -> list[ipaddress.IPv4Network]:
    """Subredes /24 a escanear.

    `hint` es la IP con la que el navegador llegó al panel: dentro de Docker el
    contenedor no conoce la red del local, pero el navegador sí.
    """
    nets: list[ipaddress.IPv4Network] = []

    def add(ip: str) -> None:
        try:
            addr = ipaddress.IPv4Address(ip)
        except ValueError:
            return
        if not addr.is_private or addr.is_loopback:
            return
        # Redes internas de Docker: no hay cámaras ahí.
        if addr in ipaddress.IPv4Network("172.16.0.0/12") and not extra:
            return
        net = ipaddress.IPv4Network(f"{addr}/24", strict=False)
        if net not in nets:
            nets.append(net)

    for e in extra:
        try:
            net = ipaddress.IPv4Network(e, strict=False)
            if net.num_addresses <= 1024 and net not in nets:
                nets.append(net)
        except ValueError:
            add(e)
    if hint:
        add(hint)
    for ip in _own_ipv4():
        add(ip)
    if not nets:
        for fallback in ("192.168.0.0/24", "192.168.1.0/24"):
            nets.append(ipaddress.IPv4Network(fallback))
    return nets[:4]


# --- Escaneo ---------------------------------------------------------------------
async def _port_open(ip: str, port: int, timeout: float) -> bool:
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(ip, port), timeout)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return True
    except (OSError, asyncio.TimeoutError):
        return False


async def _http_banner(ip: str, timeout: float = 1.5) -> tuple[str | None, str | None]:
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(ip, 80), timeout)
        writer.write(f"GET / HTTP/1.0\r\nHost: {ip}\r\nUser-Agent: retail-analytics\r\n\r\n".encode())
        await writer.drain()
        data = await asyncio.wait_for(reader.read(6000), timeout)
        writer.close()
    except (OSError, asyncio.TimeoutError):
        return None, None
    text = data.decode("latin-1", errors="ignore").lower()
    brand = next((b for pattern, b in BANNERS if re.search(pattern, text)), None)
    m = re.search(r"<title>([^<]{1,80})</title>", text)
    return brand, (m.group(1).strip() if m else None)


def _ws_discovery(timeout: float = 2.0) -> set[str]:
    """Probe ONVIF WS-Discovery. Sólo funciona si el contenedor ve la LAN (host network)."""
    msg = f"""<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
 xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
 xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
 xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
<e:Header><w:MessageID>uuid:{uuid.uuid4()}</w:MessageID>
<w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
<w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>
<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>"""
    found: set[str] = set()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    try:
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
        sock.settimeout(0.3)
        sock.sendto(msg.encode(), ("239.255.255.250", 3702))
        import time

        end = time.time() + timeout
        while time.time() < end:
            try:
                data, addr = sock.recvfrom(65535)
            except socket.timeout:
                continue
            found.add(addr[0])
            for x in re.findall(rb"https?://(\d+\.\d+\.\d+\.\d+)", data):
                found.add(x.decode())
    except OSError as exc:
        logger.debug("WS-Discovery no disponible: %s", exc)
    finally:
        sock.close()
    return found


async def discover(hint: str | None = None, extra_subnets: list[str] | None = None) -> dict[str, Any]:
    nets = candidate_subnets(hint, extra_subnets or [])
    ws_task = asyncio.create_task(asyncio.to_thread(_ws_discovery))
    sem = asyncio.Semaphore(256)
    devices: dict[str, Device] = {}

    async def check(ip: str, port: int) -> None:
        async with sem:
            if await _port_open(ip, port, 0.6):
                devices.setdefault(ip, Device(ip)).ports.append(port)

    targets = [str(h) for net in nets for h in net.hosts()]
    await asyncio.gather(*(check(ip, p) for ip in targets for p in PORTS))

    for ip in await ws_task:
        d = devices.setdefault(ip, Device(ip))
        d.onvif = True

    # Sólo interesan equipos con video: RTSP, puertos SDK de CCTV u ONVIF.
    cctv_ports = {p for p, b in PORTS.items() if b} | {554}
    cams = [d for d in devices.values() if d.onvif or cctv_ports & set(d.ports)]

    async def enrich(d: Device) -> None:
        for p in d.ports:
            if PORTS.get(p) and PORTS[p] != "onvif":
                d.brand = PORTS[p]
        if 80 in d.ports:
            brand, title = await _http_banner(d.ip)
            d.brand = brand or d.brand
            d.title = title
        if not d.brand and (d.onvif or 8899 in d.ports):
            d.brand = "onvif"

    await asyncio.gather(*(enrich(d) for d in cams))
    cams.sort(key=lambda d: (554 not in d.ports, ipaddress.IPv4Address(d.ip)))
    return {"subnets": [str(n) for n in nets], "devices": [d.as_dict() for d in cams]}


# --- Conexión automática -----------------------------------------------------------
def build_url(ip: str, port: int, user: str, password: str, template: str, channel: int) -> str:
    path = template.format(ch=channel, user=quote(user, safe=""), password=quote(password, safe=""))
    creds = ""
    if user and "user=" not in template:
        creds = quote(user, safe="") + (f":{quote(password, safe='')}" if password else "") + "@"
    return f"rtsp://{creds}{ip}:{port}{path}"


def _templates_for(brand: str | None) -> list[tuple[str, str]]:
    order = ([brand] if brand in RTSP_TEMPLATES else []) + [b for b in BRAND_ORDER if b != brand]
    return [(b, t) for b in order for t in RTSP_TEMPLATES[b]]


def autoconnect(
    ip: str,
    user: str,
    password: str,
    brand: str | None,
    channel: int = 1,
    port: int = 554,
    transport: str = "tcp",
    max_attempts: int = 14,
    timeout_s: float = 4.0,
) -> dict[str, Any]:
    try:
        with socket.create_connection((ip, port), timeout=2.0):
            pass
    except OSError:
        return {
            "ok": False,
            "message": f"El equipo {ip} no acepta conexiones RTSP en el puerto {port}. "
            "Habilitá RTSP en el grabador o revisá el puerto (suele ser 554).",
            "tried": [],
        }
    tried: list[dict[str, Any]] = []
    auth_failures = 0
    for b, template in _templates_for(brand)[:max_attempts]:
        url = build_url(ip, port, user, password, template, channel)
        result = probe_source(url, transport, timeout_s)
        tried.append({"brand": b, "template": template, "ok": result["ok"], "elapsed_ms": result["elapsed_ms"]})
        if result["ok"]:
            return {
                "ok": True,
                "brand": b,
                "brand_label": BRAND_LABELS.get(b, b),
                "template": template,
                "video_source": url,
                "result": result,
                "tried": tried,
            }
        if result["elapsed_ms"] < 1500:
            auth_failures += 1
    hint = (
        "La cámara responde pero rechaza todas las rutas: revisá usuario y clave (son los del grabador, no los de la cuenta de la app)."
        if auth_failures >= len(tried) // 2
        else "No se obtuvo imagen. Verificá que RTSP esté habilitado en el grabador (Configuración → Red → Puertos)."
    )
    return {"ok": False, "message": hint, "tried": tried}


def scan_channels(
    ip: str,
    user: str,
    password: str,
    template: str,
    max_channels: int = 8,
    port: int = 554,
    transport: str = "tcp",
    timeout_s: float = 4.0,
) -> list[dict[str, Any]]:
    """Miniatura por canal; corta tras 2 canales seguidos sin imagen."""
    out: list[dict[str, Any]] = []
    misses = 0
    for ch in range(1, max_channels + 1):
        url = build_url(ip, port, user, password, template, ch)
        r = probe_source(url, transport, timeout_s)
        if r["ok"]:
            misses = 0
            out.append({"channel": ch, "video_source": url, "snapshot": r["snapshot"], "width": r["width"], "height": r["height"]})
        else:
            misses += 1
            if misses >= 2 and out:
                break
            if misses >= 3:
                break
    return out

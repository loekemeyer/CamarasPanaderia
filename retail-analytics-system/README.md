# Retail Analytics: analítica de video en tiempo real

Sistema de analítica de video para retail. Toma el stream de una cámara de seguridad (RTSP o un mp4), detecta personas con **YOLOv8** y las sigue con **ByteTrack**. Con eso calcula en tiempo real:

- **Conteo**: personas en cuadro, ingresos y finalizaciones por hora.
- **Permanencia (dwell time)** por `track_id`, desde la entrada hasta la salida, agrupada en `<3m`, `3-6m`, `6-10m` y `>10m`.
- **Fila y acumulación**: personas dentro de la zona de caja, tiempo de espera e índice 0-100 de acumulación/fluidez.
- **Alertas**: acumulación sostenida, fila que supera la capacidad y espera prolongada.

Las métricas se publican por **Redis Pub/Sub** y llegan a un dashboard React por **WebSocket**. Se persisten en **PostgreSQL/TimescaleDB**, que alimenta el historial y el mapa de calor semanal.

```
Cámara RTSP / mp4
      │
      ▼
┌─────────────────────────── backend (FastAPI) ───────────────────────────┐
│ VisionWorker (hilo)                                                     │
│   FrameGrabber ─► YOLOv8n (class 0) + ByteTrack ─► MetricsEngine        │
│        │                                             │   │              │
│        └─► último JPEG ─► /api/stream/mjpeg          │   └─► Timescale  │
│                                                      ▼      (metrics,   │
│                                          Redis Pub/Sub       visits,    │
│                                    (metrics 1 Hz, tracks 5 Hz, alerts)  │
│                                                      │                  │
│ ConnectionManager ◄──────────────────────────────────┘                  │
│        └─► /ws/metrics ─────────────┐     REST /api/metrics|alerts|config│
└─────────────────────────────────────┼───────────────────────────────────┘
                                      ▼
                     frontend (React + Tailwind, Nginx :8080)
```

## Estructura

```
retail-analytics-system/
├── backend/
│   ├── app/
│   │   ├── main.py              FastAPI, CORS, lifespan, WebSocket /ws/metrics
│   │   ├── config.py            Pydantic Settings (variables de entorno)
│   │   ├── database.py          SQLAlchemy + TimescaleDB + Redis
│   │   ├── models/              MetricSnapshot (hypertable), Visit, Alert, Zone
│   │   ├── schemas/             Pydantic de entrada/salida
│   │   ├── routers/             metrics, alerts, config, stream (MJPEG)
│   │   └── services/
│   │       ├── vision_worker.py YOLOv8 + tracking + métricas + simulador
│   │       ├── websocket_mgr.py Broadcasting vía Redis Pub/Sub
│   │       └── demo_seed.py     Historial sintético (sólo modo demo)
│   ├── tests/                   Pruebas del motor de métricas
│   ├── Dockerfile
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── components/          CameraFeed, MetricGauge, DemandChart,
│   │   │                        DwellTimeCard, WeeklyHeatmap, AlertsPanel…
│   │   ├── hooks/useWebSocket.ts
│   │   ├── lib/                 api, tipos, formato es-AR
│   │   ├── App.tsx              Bento grid del dashboard
│   │   └── main.tsx, index.css
│   ├── nginx.conf               Sirve el build y hace proxy de /api y /ws
│   ├── tailwind.config.js
│   └── Dockerfile
├── data/                        Montado en /data (videos mp4 de prueba)
├── docker-compose.yml
└── .env.example
```

## Inicio rápido

Requisitos: Docker 24+ con Compose v2, unos 6 GB libres para las imágenes y 2 vCPU como mínimo (conviene tener 4 para correr YOLO en CPU a 8 fps).

```bash
cd retail-analytics-system
cp .env.example .env           # opcional: sin .env se usan los valores por defecto
docker compose up --build
```

| Servicio | URL |
|---|---|
| Dashboard | http://localhost:8080 |
| API + Swagger | http://localhost:8000/docs |
| Salud | http://localhost:8000/api/health |

**Sin cámara ni video**, `VISION_MODE=auto` detecta que no puede abrir la fuente y pasa al **modo simulado**. Ese modo genera clientes sintéticos que entran, recorren el local, hacen fila, son atendidos y salen. Además siembra 28 días de historial para que se vean el mapa de calor y los gráficos. En el visor aparece el cartel **DEMO**.

### Probar con un video mp4

1. Copiá un video de un local con personas en `data/sample.mp4`. Sirve cualquier clip de cámara cenital o de 3/4, por ejemplo de un banco de videos libres.
2. Levantá todo con `docker compose up --build`. El archivo se reproduce en loop y a velocidad real.

> El historial demo se siembra **sólo** cuando la fuente es simulada y la tabla `metrics` está vacía. Todas las filas sintéticas tienen `source = 'simulated'`, así que se pueden purgar sin tocar datos reales:
> `DELETE FROM metrics WHERE source='simulated'; DELETE FROM visits WHERE source='simulated';`

## Conectar una cámara de seguridad física (RTSP)

1. **Obtené la URL RTSP** del NVR o de la cámara. Formatos habituales:

   | Marca | URL |
   |---|---|
   | Hikvision | `rtsp://usuario:clave@IP:554/Streaming/Channels/101` (102 = substream) |
   | Dahua | `rtsp://usuario:clave@IP:554/cam/realmonitor?channel=1&subtype=0` |
   | Reolink | `rtsp://usuario:clave@IP:554/h264Preview_01_main` |
   | Uniview | `rtsp://usuario:clave@IP:554/unicast/c1/s0/live` |
   | Genérica ONVIF | la que figure en ONVIF Device Manager, en *Live video* |

2. **Usá el substream** (720p o menos). YOLOv8n trabaja a 640 px, así que el stream principal en 4K sólo consume ancho de banda y CPU.
3. **Verificá la URL desde la máquina que corre Docker**:
   ```bash
   ffprobe -rtsp_transport tcp "rtsp://usuario:clave@192.168.1.64:554/Streaming/Channels/102"
   ```
   Si falla, revisá usuario y clave, que el puerto 554 esté abierto en el firewall y que RTSP esté habilitado en la cámara.
4. **Configurá `.env`**:
   ```env
   VIDEO_SOURCE=rtsp://usuario:clave@192.168.1.64:554/Streaming/Channels/102
   VISION_MODE=yolo          # con "yolo" reintenta con backoff y no cae al simulador
   CAMERA_NAME=Caja principal
   RTSP_TRANSPORT=tcp        # udp si la red es muy estable y querés menos latencia
   SEED_DEMO_HISTORY=false
   ```
   Si la clave tiene caracteres especiales, codificalos en URL (`@` → `%40`, `#` → `%23`).
5. **Reiniciá el backend** con `docker compose up -d --build backend`. La URL se muestra enmascarada en `/api/config/system`.
6. **Calibrá la zona de fila.** Las zonas son polígonos en coordenadas normalizadas (0-1) sobre el cuadro, y una persona cuenta "en fila" cuando **el punto medio del borde inferior** de su caja cae dentro de la zona `queue`:
   ```bash
   curl http://localhost:8000/api/config/zones                 # listar
   curl -X PUT http://localhost:8000/api/config/zones/1 \
        -H 'Content-Type: application/json' \
        -d '{"polygon": [[0.55,0.35],[0.95,0.35],[0.95,0.85],[0.55,0.85]], "capacity": 6}'
   ```
   Para ubicar los puntos, bajá un cuadro con `curl -o frame.jpg http://localhost:8000/api/stream/snapshot.jpg`, medilo en cualquier editor de imágenes y dividí cada coordenada por el ancho o el alto. El worker recarga las zonas sin reiniciar.

**La red del contenedor tiene que llegar a la cámara.** En Linux, si la cámara está en la LAN, el bridge por defecto suele alcanzar. Si no, agregá `network_mode: host` al servicio `backend`.

### GPU (opcional)

Con una GPU NVIDIA y el NVIDIA Container Toolkit instalados:

```env
TORCH_INDEX_URL=https://download.pytorch.org/whl/cu121
YOLO_DEVICE=0
PROCESS_FPS=15
```

y agregá al servicio `backend`:

```yaml
    deploy:
      resources:
        reservations:
          devices: [{ driver: nvidia, count: 1, capabilities: [gpu] }]
```

## Variables principales

| Variable | Default | Uso |
|---|---|---|
| `VIDEO_SOURCE` | `/data/sample.mp4` | mp4, `rtsp://…`, `http://…` o índice de webcam (`0`) |
| `VISION_MODE` | `auto` | `auto`, `yolo` o `simulate` |
| `PROCESS_FPS` | `8` | cuadros por segundo que se procesan |
| `YOLO_MODEL` / `YOLO_DEVICE` | `yolov8n.pt` / `cpu` | modelo y dispositivo |
| `YOLO_CONFIDENCE` | `0.35` | confianza mínima de detección |
| `MIN_VISIT_SECONDS` | `2` | tiempo mínimo para contar un ingreso (filtra falsos positivos) |
| `TRACK_EXIT_TIMEOUT_S` | `3` | segundos sin ver un track para darlo por salido |
| `QUEUE_CAPACITY` | `8` | capacidad de la fila, si la zona no define una |
| `QUEUE_TARGET_WAIT_S` | `180` | espera objetivo en fila |
| `MAX_OCCUPANCY` | `40` | ocupación de referencia del local |
| `ACCUMULATION_ALERT_THRESHOLD` | `75` | umbral del índice para alertar |
| `ACCUMULATION_ALERT_SUSTAIN_S` | `20` | segundos que el índice debe sostenerse sobre el umbral |
| `ALERT_COOLDOWN_S` | `300` | tiempo mínimo entre alertas del mismo tipo |
| `TIMEZONE` | `America/Argentina/Buenos_Aires` | zona horaria para agrupar por hora y día |
| `SEED_DEMO_HISTORY` | `true` | siembra historial sólo en modo simulado |

La lista completa está en `backend/app/config.py`.

### Índice de acumulación (0-100)

```
score = 100 × (0,55 × min(fila / capacidad, 1)
             + 0,30 × min(espera_prom / espera_objetivo, 1)
             + 0,15 × min(personas / ocupación_máx, 1))
```

El índice se suaviza con una media exponencial (τ = 3 s). Los niveles son: `<35` fluido, `35-60` moderado, `60-80` alto y `≥80` crítico.

## API

| Método | Ruta | Descripción |
|---|---|---|
| WS | `/ws/metrics` | mensajes `hello`, `metrics` (1 Hz), `tracks` (5 Hz), `alert` y `pong` |
| GET | `/api/metrics/live` | última muestra en memoria |
| GET | `/api/metrics/history?hours=24&bucket=5m` | serie agregada (`1m`, `5m`, `15m`, `1h`) |
| GET | `/api/metrics/hourly?day=YYYY-MM-DD` | ingresos y finalizaciones por hora |
| GET | `/api/metrics/dwell?hours=24` | distribución de permanencia |
| GET | `/api/metrics/heatmap?days=28` | matriz día × hora |
| GET | `/api/metrics/summary` | resumen del día |
| GET | `/api/alerts?hours=24&only_open=true` | alertas |
| POST | `/api/alerts/{id}/ack` | marcar alerta como vista |
| GET/POST/PUT/DELETE | `/api/config/zones` | ABM de zonas |
| GET | `/api/config/system` | estado del worker, DB, Redis y reglas |
| GET | `/api/stream/mjpeg` · `/api/stream/snapshot.jpg` | video del último cuadro |

## Desarrollo local sin Docker

```bash
# Infra
docker compose up -d postgres redis

# Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install --index-url https://download.pytorch.org/whl/cpu torch==2.5.1 torchvision==0.20.1
pip install -r requirements.txt pytest
export DATABASE_URL=postgresql+psycopg2://retail:retail@localhost:5432/retail REDIS_URL=redis://localhost:6379/0
uvicorn app.main:app --reload
pytest -q

# Frontend (con proxy a :8000)
cd ../frontend
npm install
npm run dev        # http://localhost:5173
```

## Limitaciones conocidas

- **Una sola cámara por instancia del backend.** Para más cámaras, levantá una réplica por cámara con otro `CAMERA_ID`. El Pub/Sub ya separa los mensajes por `camera_id`, pero el dashboard muestra una cámara a la vez.
- **Oclusiones y reingresos.** Si alguien queda oculto más de `TRACK_EXIT_TIMEOUT_S`, ByteTrack le asigna otro ID y se cuenta como una visita nueva. En locales con góndolas altas conviene subir ese valor a 5-8 s.
- **"Finalizaciones" son una estimación**: equivalen a salidas de cuadro, no a tickets de venta. Para medir conversión hay que cruzarlas con el POS.
- **Privacidad.** No se guardan imágenes ni se identifica a nadie, sólo coordenadas y tiempos. Aun así, informá la videovigilancia con cartelería según la normativa local (en Argentina, la Ley 25.326 y la Disposición AAIP 10/2015).

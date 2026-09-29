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

## Instalación en la PC del local (sin costo)

Hace falta una computadora que **ya esté en el local**, que quede prendida y conectada al mismo router que el grabador de las cámaras: la PC de la caja o una notebook vieja. Requisitos: 8 GB de RAM y 15 GB libres.

**Windows 10/11**
1. Descargá este repositorio como ZIP (en GitHub: *Code → Download ZIP*) y descomprimilo, por ejemplo en `C:\Panaderia`.
2. Hacé doble clic en **`INSTALAR-WINDOWS.bat`**.
   - Si falta Docker Desktop, lo instala. Es gratis para comercios de menos de 250 empleados. Después pide reiniciar la PC y volver a hacer doble clic.
   - La segunda vez construye el sistema (tarda de 10 a 20 minutos la primera vez) y lo deja arrancando solo con Windows.
   - Genera una clave de administración y deja en el escritorio el archivo **`Panel Panaderia - ACCESO.txt`**, con la dirección para el celular y la clave.
3. Se abre el navegador en **Configuración → Cámara**. Tocá **Buscar cámaras en la red**, elegí el grabador, poné el usuario y la clave del grabador, y elegí la cámara que mira la caja.

**Ubuntu/Debian** (por ejemplo, una notebook vieja): `bash scripts/instalar-linux.sh`.

**Desde el celular:** con el teléfono conectado a la Wi-Fi del local, abrí la dirección `http://IP-DE-LA-PC:8080` que figura en el archivo de acceso. En el menú del navegador, *Agregar a pantalla de inicio* la deja como una app más. En el celular el panel muestra primero el índice de fila, los números del día y las alertas.

> Este sistema **no reemplaza** la app de cámaras que la panadería ya usa (Hik-Connect, DMSS, iCSee, etc.): la app sigue para ver video, y este sistema agrega la analítica. La app del celular entra por la nube del fabricante, que no le entrega video a otros programas. Por eso el análisis lee el grabador directo, dentro de la red del local.

## Inicio rápido (desarrollo)

Requisitos: Docker 24+ con Compose v2.

```bash
cd retail-analytics-system
cp .env.example .env
docker compose up --build
```

| Servicio | URL |
|---|---|
| Dashboard | http://localhost:8080 |
| API + Swagger | http://localhost:8000/docs |
| Salud | http://localhost:8000/api/health |

**Sin cámara ni video**, `VISION_MODE=auto` pasa al **modo simulado**, con clientes sintéticos y 28 días de historial, y el visor muestra el cartel **DEMO**.

## Todo se configura desde la web

La terminal se usa una sola vez, para instalar (`docker compose up --build`). Después todo se opera desde **Configuración**, en el dashboard (http://localhost:8080/#/configuracion):

| Sección | Qué se hace |
|---|---|
| **Cámara → Conexión automática** | Busca en la red el grabador y las cámaras (ONVIF y puertos de CCTV) y reconoce la marca: Hikvision, Dahua, XMEye/iCSee, Reolink, Uniview, EZVIZ, Tapo. Con el usuario y la clave prueba sola las direcciones de video conocidas y muestra una miniatura por canal del grabador para elegir la que mira la caja. |
| **Cámara → Configuración manual** | Armar la URL RTSP eligiendo marca, IP, usuario, clave, canal y calidad. Subir un video de prueba arrastrándolo. Usar una URL HTTP o una webcam USB. **Probar conexión** muestra un cuadro real, la resolución y los fps antes de guardar. Al guardar, el sistema reconecta en el acto y el panel de estado en vivo lo confirma. |
| **Zonas** | Dibujar sobre la imagen 4 tipos de zona: **Fila de caja**, **Punto de atención** (donde se paga), **Personal** (detrás del mostrador) y **Área** informativa. Clic para agregar puntos, arrastrar vértices, doble clic para quitar uno. |
| **Reglas** | Capacidad de la fila, espera objetivo, ocupación de referencia, umbral y duración de las alertas, y ajuste fino del seguimiento. Se aplican en vivo, sin reiniciar. |
| **Avisos** | Telegram gratis, en 3 pasos: crear el bot con @BotFather, escribirle "hola" y tocar **Detectar chat**, y **Enviar prueba**. Se elige qué alertas llegan en el momento y a qué hora sale el **resumen del día**. |
| **Datos** | Cantidad de registros reales y simulados, **borrado de los datos de demo** y **exportación a CSV** para Excel (separador `;`, coma decimal). |

Lo que se configura en la web queda guardado en la tabla `app_settings` y tiene prioridad sobre `.env`.

### Clave de administración

Definí `ADMIN_PASSWORD` en `.env` antes del primer arranque. La web la pide para entrar a Configuración, y la API la exige para cualquier cambio (encabezado `X-Admin-Password`). Si queda vacía, cualquiera que llegue a la IP del equipo puede cambiar la cámara o borrar datos. Dejala vacía sólo en una red aislada.

> La clave de la cámara se guarda en texto plano en la base de datos, y la web la muestra enmascarada (`••••••`). Conviene crear en el NVR un usuario **sólo de visualización** para este sistema.

### Probar con un video

En **Configuración → Cámara → Video subido**, arrastrá un mp4 de un local con personas. Después elegí el modo **Cámara real**, tocá **Probar conexión** y **Guardar y aplicar**. El video se reproduce en loop y a velocidad real.

> El historial demo se siembra **sólo** cuando la fuente es simulada y la tabla `metrics` está vacía. Todas las filas sintéticas quedan marcadas y se borran desde **Datos → Borrar datos simulados**, sin tocar los datos de la cámara.

## Conectar una cámara de seguridad física (RTSP)

Lo más fácil es el asistente: **Configuración → Cámara → Buscar cámaras en la red**. Si no encuentra nada o preferís hacerlo a mano:

1. En **Configuración → Cámara → Configuración manual → Cámara IP (RTSP)**, elegí la marca y completá IP, puerto (554), usuario, clave y canal. Dejá **Substream**, porque YOLOv8n trabaja a 640 px y el stream principal en 4K sólo consume ancho de banda. Tocá **Armar URL**.
2. Tocá **Probar conexión**. Si aparece el cuadro de la cámara, la URL es correcta. Si falla, el mensaje indica si no abrió (IP, clave o RTSP deshabilitado) o si abrió sin mandar imagen (probá con el substream o con TCP).
3. Elegí el modo **Cámara real**. A diferencia de *Automático*, nunca cae a datos simulados: si la cámara se corta, reintenta. Tocá **Guardar y aplicar**.
4. En **Zonas**, tocá **Actualizar cuadro** y ajustá el polígono de *Fila de caja* sobre la imagen real. Una persona cuenta "en fila" cuando el punto medio del borde inferior de su caja (los pies) cae dentro de la zona.
5. En **Datos**, borrá los datos simulados para que el historial refleje sólo el local.

Formatos de URL que arma la web:

| Marca | Ruta |
|---|---|
| Hikvision / HiLook | `/Streaming/Channels/101` (principal) · `102` (substream) |
| Dahua / Imou | `/cam/realmonitor?channel=1&subtype=0` · `subtype=1` |
| Reolink | `/h264Preview_01_main` · `_sub` |
| Uniview | `/unicast/c1/s0/live` · `s1` |

**La red del contenedor tiene que llegar a la cámara.** En Linux, si la cámara está en la LAN, el bridge por defecto suele alcanzar. Si **Probar conexión** falla con una URL que sí anda en VLC, agregá `network_mode: host` al servicio `backend`.

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

### Zonas y qué mide cada una

| Zona | Qué hace |
|---|---|
| Fila de caja | Cuenta quién está en fila y cuánto espera. Alimenta el índice de acumulación. |
| Punto de atención | Quien pasa 3 s acá cuenta como **atendido**. Quien hizo fila (30 s o más, configurable) y se fue sin pasar por acá cuenta como **abandono**. Sin esta zona, los abandonos no se miden. |
| Personal | Quien la pisa es empleado: **no cuenta como cliente**, así el conteo y la permanencia no se inflan. Si hay 2 o más clientes en fila y nadie en esta zona durante 30 s, dispara la alerta **Caja sin atender**. |
| Área | Informativa: sólo se dibuja en el visor. |

Alertas: acumulación alta, fila que supera la capacidad, espera prolongada, **abandonos** (3 o más en 15 min) y **caja sin atender**.

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
| `ADMIN_PASSWORD` | vacío | clave para la sección Configuración |

La lista completa está en `backend/app/config.py`. Las variables de cámara y reglas son sólo el valor inicial: después mandan los cambios hechos en la web.

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
| GET/PUT | `/api/config/camera` · `/api/config/rules` | configuración de cámara y reglas |
| POST | `/api/config/camera/test` | prueba de conexión (devuelve un cuadro JPEG) |
| POST | `/api/config/discovery` | búsqueda de cámaras y grabadores en la red |
| POST | `/api/config/camera/autoconnect` · `/api/config/camera/channels` | conexión automática y miniaturas por canal |
| GET/POST/DELETE | `/api/config/videos` | videos de prueba (subida multipart) |
| GET · POST | `/api/config/data/stats` · `/api/config/data/purge-simulated` | datos almacenados y borrado de demo |
| GET | `/api/metrics/export.csv?days=30&bucket=1h` | exportación a Excel |
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

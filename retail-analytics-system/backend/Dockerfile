FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    YOLO_CONFIG_DIR=/app/.ultralytics

# Librerías de sistema que requiere OpenCV (GUI mínima + FFmpeg para RTSP/mp4).
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Torch CPU (evita ~2 GB de CUDA). Para GPU, cambiar el índice por el de CUDA.
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
COPY requirements.txt .
RUN pip install --index-url ${TORCH_INDEX_URL} torch==2.5.1 torchvision==0.20.1 \
    && pip install -r requirements.txt

# Descarga los pesos de YOLOv8n en build para arrancar sin red.
RUN python -c "from ultralytics import YOLO; YOLO('yolov8n.pt')"

COPY app ./app

EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
    CMD curl -fsS http://localhost:8000/api/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]

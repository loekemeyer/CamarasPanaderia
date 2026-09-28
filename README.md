# CamarasPanaderia

Analítica de video en tiempo real para el local: conteo de personas, permanencia, filas en caja y acumulación, con un dashboard en vivo.

El sistema completo (backend FastAPI + YOLOv8, dashboard React, Docker Compose) está en [`retail-analytics-system/`](retail-analytics-system/README.md).

```bash
cd retail-analytics-system && docker compose up --build
# Dashboard: http://localhost:8080 · API: http://localhost:8000/docs
```

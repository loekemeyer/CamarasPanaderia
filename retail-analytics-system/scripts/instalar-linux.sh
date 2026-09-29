#!/usr/bin/env bash
# Instalador para una PC o notebook con Ubuntu/Debian (por ejemplo una notebook vieja del local).
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Instalando Docker"
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER" || true
fi
sudo systemctl enable --now docker

if [ ! -f .env ]; then
  cp .env.example .env
  pass=$(tr -dc 'a-km-np-z2-9' </dev/urandom | head -c 10)
  dbpass=$(tr -dc 'a-km-np-z2-9' </dev/urandom | head -c 24)
  sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$pass/; s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$dbpass/" .env
fi
pass=$(grep '^ADMIN_PASSWORD=' .env | cut -d= -f2-)

echo "==> Levantando (la primera vez tarda 10-20 minutos)"
sudo docker compose up -d --build

ip=$(hostname -I | awk '{print $1}')
cat <<MSG

LISTO
  En esta PC:     http://localhost:8080
  En el celular:  http://$ip:8080  (misma Wi-Fi del local)
  Clave:          $pass
Primer uso: Configuración > Cámara > "Buscar cámaras en la red".
MSG

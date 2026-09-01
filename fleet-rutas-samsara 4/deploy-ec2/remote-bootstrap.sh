#!/bin/bash
# Se ejecuta como root (sudo) DENTRO de la instancia EC2.
# Instala Node, Postgres, nginx y pm2; descomprime la app e instala sus dependencias.
# No toca secretos ni base de datos todavía (eso lo hace remote-configure.sh).
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

echo "Actualizando paquetes..."
apt-get update -y
apt-get upgrade -y

echo "Instalando Node.js 20 LTS..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

echo "Instalando PostgreSQL, nginx, unzip..."
apt-get install -y postgresql postgresql-contrib nginx unzip

echo "Instalando pm2..."
npm install -g pm2

echo "Descomprimiendo la app..."
sudo -u ubuntu bash -c '
  set -e
  cd /home/ubuntu
  unzip -o fleet-rutas-samsara.zip
'

if [ ! -f /home/ubuntu/fleet-rutas-samsara/package.json ]; then
  echo "ERROR: no se encontró /home/ubuntu/fleet-rutas-samsara/package.json después de descomprimir."
  echo "Revisa que subiste bien fleet-rutas-samsara.zip a la instancia."
  exit 1
fi

echo "Instalando dependencias de la app (npm install)..."
sudo -u ubuntu bash -c '
  set -e
  cd /home/ubuntu/fleet-rutas-samsara
  npm install --omit=dev
'

echo "Verificando que las dependencias clave quedaron instaladas..."
if [ ! -d /home/ubuntu/fleet-rutas-samsara/node_modules/bcryptjs ]; then
  echo "AVISO: bcryptjs no quedó instalado en el primer intento, reintentando npm install..."
  sudo -u ubuntu bash -c '
    set -e
    cd /home/ubuntu/fleet-rutas-samsara
    rm -rf node_modules package-lock.json
    npm install --omit=dev
  '
fi

if [ ! -d /home/ubuntu/fleet-rutas-samsara/node_modules/bcryptjs ]; then
  echo "ERROR: no se pudo instalar bcryptjs (revisa la conexión a internet de la instancia / npm registry)."
  exit 1
fi

echo "Dependencias instaladas correctamente."

echo "BOOTSTRAP_OK"

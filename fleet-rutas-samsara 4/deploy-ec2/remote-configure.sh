#!/bin/bash
# Se ejecuta como root (sudo) DENTRO de la instancia EC2, después de remote-bootstrap.sh.
# Lee /home/ubuntu/secrets.tmp (subido por deploy-cloudshell.sh), configura Postgres,
# genera el .env final, siembra las rutas, arranca la app con pm2 y configura nginx.
set -euo pipefail

APP_DIR="/home/ubuntu/fleet-rutas-samsara"
SECRETS_FILE="/home/ubuntu/secrets.tmp"

if [ ! -f "$SECRETS_FILE" ]; then
  echo "ERROR: no se encontró $SECRETS_FILE"
  exit 1
fi
# shellcheck disable=SC1090
source "$SECRETS_FILE"

if [ ! -d "$APP_DIR/node_modules/bcryptjs" ]; then
  echo "AVISO: bcryptjs no estaba instalado, instalando dependencias ahora..."
  sudo -u ubuntu bash -c "cd $APP_DIR && npm install --omit=dev"
fi

echo "Configurando usuario y base de datos en PostgreSQL..."
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='rutas_app'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE USER rutas_app WITH ENCRYPTED PASSWORD '${DB_PASSWORD}';"

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='rutas_samsara'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE DATABASE rutas_samsara OWNER rutas_app;"

echo "Generando el hash de la contraseña (usando bcryptjs del propio proyecto)..."
ADMIN_PASSWORD_HASH=$(cd "$APP_DIR" && node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 10))" "$ADMIN_PASSWORD")

echo "Escribiendo .env..."
cat > "$APP_DIR/.env" <<EOF
DATABASE_URL="postgresql://rutas_app:${DB_PASSWORD}@localhost:5432/rutas_samsara"
SAMSARA_API_TOKEN="${SAMSARA_API_TOKEN}"
PORT=3000
TZ_ZONA=America/Monterrey
ADMIN_USER="${ADMIN_USER}"
ADMIN_PASSWORD_HASH="${ADMIN_PASSWORD_HASH}"
SESSION_SECRET="${SESSION_SECRET}"
SESSION_SECURE=false
EOF

chown ubuntu:ubuntu "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

echo "Sembrando rutas (solo aplica la primera vez; es seguro volver a correrlo)..."
sudo -u ubuntu bash -c "cd $APP_DIR && npm run seed"

echo "Arrancando la app con pm2..."
sudo -u ubuntu bash -c "cd $APP_DIR && pm2 delete rutas-samsara 2>/dev/null; pm2 start src/server.js --name rutas-samsara && pm2 save"

echo "Configurando pm2 para que arranque solo si la instancia se reinicia..."
STARTUP_CMD=$(pm2 startup systemd -u ubuntu --hp /home/ubuntu 2>/dev/null | tail -1 || true)
if [[ "$STARTUP_CMD" == sudo* ]]; then
  eval "${STARTUP_CMD#sudo }" || true
fi

echo "Configurando nginx como proxy reverso..."
cat > /etc/nginx/sites-available/rutas-samsara <<'NGINX'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/rutas-samsara /etc/nginx/sites-enabled/rutas-samsara
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx
systemctl enable nginx

echo "Borrando el archivo de secretos temporal..."
rm -f "$SECRETS_FILE"

echo "CONFIGURE_OK"

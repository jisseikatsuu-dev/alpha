#!/usr/bin/env bash
# Instalación inicial en EC2 (Ubuntu). Se corre UNA vez, conectado por SSH a la instancia:
#
#   curl -fsSL https://raw.githubusercontent.com/USUARIO/REPO/main/deploy/bootstrap-ec2.sh -o bootstrap.sh   (repo público)
#   # o copia el archivo a mano si el repo es privado
#   REPO_URL=git@github.com:USUARIO/REPO.git bash bootstrap.sh
#
# Variables opcionales: APP_DIR (/opt/control-viajes)  APP_PORT (3100)  BRANCH (main)  USE_NGINX (no|yes)
# Es idempotente: si lo vuelves a correr no borra la base ni el .env existente.
set -euo pipefail

REPO_URL="${REPO_URL:?Define REPO_URL, ej: REPO_URL=git@github.com:usuario/control-viajes.git}"
APP_DIR="${APP_DIR:-/opt/control-viajes}"
APP_PORT="${APP_PORT:-3100}"
BRANCH="${BRANCH:-main}"
USE_NGINX="${USE_NGINX:-no}"
APP_USER="$(whoami)"
DB_NAME="control_viajes"
DB_USER="cv_app"
SERVICE="control-viajes"

paso() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

paso "Paquetes del sistema"
sudo apt-get update -qq
sudo apt-get install -y -qq git curl openssl postgresql ca-certificates >/dev/null

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  paso "Instalando Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi
echo "Node $(node -v) · npm $(npm -v)"

# ---------- Acceso de la EC2 a GitHub (deploy key de solo lectura) ----------
if [[ "$REPO_URL" == git@github.com:* ]] && [ ! -f ~/.ssh/github_deploy ]; then
  paso "Creando deploy key para que la EC2 pueda leer el repo"
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  ssh-keygen -t ed25519 -N "" -C "ec2-deploy-$SERVICE" -f ~/.ssh/github_deploy -q
  cat >> ~/.ssh/config << EOF
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/github_deploy
  IdentitiesOnly yes
EOF
  chmod 600 ~/.ssh/config
  ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null
  echo
  echo "Agrega esta llave en GitHub → tu repo → Settings → Deploy keys → Add deploy key (sin permiso de escritura):"
  echo
  cat ~/.ssh/github_deploy.pub
  echo
  read -rp "Presiona Enter cuando la hayas agregado... "
fi

# ---------- Código ----------
paso "Clonando $REPO_URL en $APP_DIR"
sudo mkdir -p "$APP_DIR" && sudo chown "$APP_USER":"$APP_USER" "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin "$BRANCH" && git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  git clone -b "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# ---------- Base de datos + .env ----------
if [ -f "$APP_DIR/.env" ]; then
  paso ".env ya existe: se conserva (base de datos y contraseña sin cambios)"
else
  paso "Creando base de datos PostgreSQL local"
  DB_PASS="$(openssl rand -hex 16)"
  if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
    sudo -u postgres psql -qc "ALTER ROLE $DB_USER WITH LOGIN PASSWORD '$DB_PASS';"
  else
    sudo -u postgres psql -qc "CREATE ROLE $DB_USER WITH LOGIN PASSWORD '$DB_PASS';"
  fi
  sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 \
    || sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"

  paso "Usuario administrador de la captura"
  read -rp "Usuario [admin]: " ADMIN_USER; ADMIN_USER="${ADMIN_USER:-admin}"
  while :; do
    read -rsp "Contraseña: " P1; echo; read -rsp "Repite la contraseña: " P2; echo
    [ -n "$P1" ] && [ "$P1" = "$P2" ] && break; echo "No coinciden o está vacía, intenta de nuevo."
  done
  ADMIN_HASH="$(node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 10))" "$P1")"

  cat > "$APP_DIR/.env" << EOF
DATABASE_URL=postgresql://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME
SESSION_SECRET=$(openssl rand -hex 32)
ADMIN_USER=$ADMIN_USER
ADMIN_PASS_HASH='$ADMIN_HASH'
PORT=$APP_PORT
COOKIE_SECURE=false
DASHBOARD_PUBLICO=false
TOLERANCIA_MIN=5
CRITICO_MIN=15
TZ_APP=America/Monterrey
EOF
  chmod 600 "$APP_DIR/.env"
fi
APP_PORT="$(grep -E '^PORT=' "$APP_DIR/.env" | cut -d= -f2)"

# ---------- Servicio systemd ----------
paso "Servicio systemd ($SERVICE)"
sudo tee /etc/systemd/system/$SERVICE.service >/dev/null << EOF
[Unit]
Description=Control de viajes (Node)
After=network.target postgresql.service
Requires=postgresql.service

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now $SERVICE >/dev/null 2>&1
sudo systemctl restart $SERVICE

# ---------- Nginx opcional (puerto 80) ----------
if [ "$USE_NGINX" = "yes" ]; then
  paso "Nginx en puerto 80 → $APP_PORT"
  sudo apt-get install -y -qq nginx >/dev/null
  sudo tee /etc/nginx/sites-available/$SERVICE >/dev/null << EOF
server {
  listen 80;
  server_name _;
  location / {
    proxy_pass http://127.0.0.1:$APP_PORT;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }
}
EOF
  sudo ln -sf /etc/nginx/sites-available/$SERVICE /etc/nginx/sites-enabled/$SERVICE
  sudo rm -f /etc/nginx/sites-enabled/default
  OTROS="$(ls /etc/nginx/sites-enabled | grep -vx "$SERVICE" || true)"
  [ -n "$OTROS" ] && echo "⚠️  Hay otros sitios de nginx activos ($OTROS). Si alguno también usa el puerto 80, ponle server_name distinto."
  sudo nginx -t && sudo systemctl reload nginx
fi

# ---------- Llave para que GitHub Actions entre a la EC2 ----------
if [ ! -f ~/.ssh/gh_actions ]; then
  paso "Creando llave SSH para GitHub Actions"
  ssh-keygen -t ed25519 -N "" -C "github-actions-$SERVICE" -f ~/.ssh/gh_actions -q
  cat ~/.ssh/gh_actions.pub >> ~/.ssh/authorized_keys
  chmod 600 ~/.ssh/authorized_keys
fi

# ---------- Verificación ----------
paso "Verificando"
for i in $(seq 1 20); do curl -fsS "localhost:$APP_PORT/health" >/dev/null 2>&1 && OK=1 && break; sleep 1; done
if [ "${OK:-}" != 1 ]; then echo "La app no respondió. Últimos logs:"; sudo journalctl -u $SERVICE -n 40 --no-pager; exit 1; fi

TOKEN="$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)"
IP="$(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo TU_IP)"
URL="http://$IP$([ "$USE_NGINX" = yes ] || echo ":$APP_PORT")"

cat << EOF

✅ App corriendo.
   Dashboard: $URL/dashboard
   Captura:   $URL/captura
   (abre el puerto $([ "$USE_NGINX" = yes ] && echo 80 || echo "$APP_PORT") en el Security Group si no carga)

Secrets para GitHub → tu repo → Settings → Secrets and variables → Actions:
   EC2_HOST     = $IP
   EC2_USER     = $APP_USER
   EC2_SSH_KEY  = (todo el bloque de abajo, incluidas las líneas BEGIN/END)

EOF
cat ~/.ssh/gh_actions

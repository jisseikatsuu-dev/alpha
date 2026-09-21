#!/usr/bin/env bash
# Actualiza la app en la EC2 con lo último de GitHub. Lo llama GitHub Actions en cada push a main,
# y también lo puedes correr a mano:  bash /opt/control-viajes/deploy/deploy.sh
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/control-viajes}"
BRANCH="${BRANCH:-main}"
SERVICE="control-viajes"

cd "$APP_DIR"
echo "==> Bajando $BRANCH"
git fetch --prune origin "$BRANCH"
ANTES="$(git rev-parse --short HEAD)"
git reset --hard "origin/$BRANCH"
echo "    $ANTES → $(git rev-parse --short HEAD)"

echo "==> Dependencias"
if ! npm ci --omit=dev --no-audit --no-fund; then
  echo "    package-lock.json no coincide con package.json; usando npm install (regenera el lock y súbelo)"
  npm install --omit=dev --no-audit --no-fund
  git checkout -- package-lock.json 2>/dev/null || true
fi

echo "==> Reiniciando $SERVICE"
sudo systemctl restart "$SERVICE"

PORT="$(grep -E '^PORT=' .env | cut -d= -f2)"; PORT="${PORT:-3000}"
for i in $(seq 1 20); do
  if curl -fsS "localhost:$PORT/health" >/dev/null 2>&1; then echo "✅ Deploy OK en puerto $PORT"; exit 0; fi
  sleep 1
done
echo "❌ La app no respondió después del deploy. Logs:"
sudo journalctl -u "$SERVICE" -n 50 --no-pager
exit 1

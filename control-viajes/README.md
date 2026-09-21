# Control de viajes

Dos partes sobre la misma base PostgreSQL:

- **/captura** (con login): tabla editable tipo Excel. Pegas rangos desde Excel/Sheets directo sobre las celdas o con "Pegar desde Excel" (reconoce encabezados). Ctrl+S guarda.
- **/dashboard** (solo lectura): KPIs, alertas, resumen por cliente y tabla del día. Se refresca cada 30 s, sigue el día actual y tiene botón de imprimir.

## Correr local
```bash
cp .env.example .env   # llena DATABASE_URL, SESSION_SECRET, ADMIN_USER, ADMIN_PASS
npm install
npm start              # http://localhost:3000
```
La tabla `viajes` (y `sesiones`) se crean solas al arrancar; no hay migración manual.

## Railway
1. Nuevo servicio desde el repo + plugin PostgreSQL.
2. Variables: `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `SESSION_SECRET`, `ADMIN_USER`, `ADMIN_PASS_HASH` (genera con `npm run hash -- "tuPassword"`), `COOKIE_SECURE=true`.
3. Opcional: `DASHBOARD_PUBLICO=true` para ver el dashboard sin login en una pantalla/TV.

## EC2 + GitHub Actions
Cada push a `main` se despliega solo en la EC2.

**Una sola vez, en la EC2 (por SSH):**
```bash
# copia deploy/bootstrap-ec2.sh a la instancia y corre:
REPO_URL=git@github.com:USUARIO/REPO.git bash bootstrap-ec2.sh
# opcional: APP_PORT=3100 (default)  USE_NGINX=yes para servir en el puerto 80
```
Instala Node 20 y PostgreSQL, crea la base, te pide usuario/contraseña de captura, genera `.env`, deja la app como servicio systemd (`control-viajes`) y al final imprime los 3 secrets.

**En GitHub → Settings → Secrets and variables → Actions:** `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY` (los que imprimió el script).

**Security Group:** abre el puerto de la app (3100, o 80 con nginx) y el 22 para que GitHub Actions pueda entrar por SSH.

Comandos útiles en la EC2: `sudo systemctl status control-viajes` · `sudo journalctl -u control-viajes -f` · deploy manual `bash /opt/control-viajes/deploy/deploy.sh`.

## Estatus
- Llegada real vs llegada programada: ≤ `TOLERANCIA_MIN` → a tiempo, > tolerancia → retraso, > `CRITICO_MIN` → crítico.
- Con encendido y sin llegada → en ruta. Sin encendido → pendiente (alerta si ya pasó la hora de inicio).
- Los cálculos toleran cruce de medianoche (turno 3).

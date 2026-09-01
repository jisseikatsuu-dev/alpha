#!/bin/bash
# ============================================================
# Despliega "Rutas Samsara" en una instancia EC2 nueva,
# corriendo TODO desde AWS CloudShell.
#
# ANTES DE CORRERLO:
#   1. Abre AWS CloudShell en la consola de AWS (icono >_ arriba a la derecha).
#   2. Sube estos 3 archivos a CloudShell con "Actions > Upload file":
#        - fleet-rutas-samsara.zip
#        - remote-bootstrap.sh
#        - remote-configure.sh
#      (deben quedar los 3 en tu home, ej: /home/cloudshell-user/)
#   3. Corre:
#        chmod +x deploy-cloudshell.sh
#        ./deploy-cloudshell.sh
#
# Te va a pedir: usuario/contraseña del dashboard y tu SAMSARA_API_TOKEN.
# Todo lo demás (VPC, security group, instancia, Node, Postgres, nginx,
# pm2, la base de datos y el .env) lo hace el script.
# ============================================================
set -euo pipefail

APP_ZIP="$HOME/fleet-rutas-samsara.zip"
BOOTSTRAP_SCRIPT="$HOME/remote-bootstrap.sh"
CONFIGURE_SCRIPT="$HOME/remote-configure.sh"

KEY_NAME="rutas-samsara-key"
SG_NAME="rutas-samsara-sg"
INSTANCE_NAME="rutas-samsara"
INSTANCE_TYPE="t3.small"

REGION="$(aws configure get region 2>/dev/null || true)"
REGION="${REGION:-us-east-1}"

echo "== Región: $REGION =="

for f in "$APP_ZIP" "$BOOTSTRAP_SCRIPT" "$CONFIGURE_SCRIPT"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: no encuentro $f"
    echo "Sube los 3 archivos a CloudShell primero (Actions > Upload file) y vuelve a correr el script."
    exit 1
  fi
done

# --- 1. Key pair para SSH ---
if [ -f "$HOME/${KEY_NAME}.pem" ]; then
  echo "Ya existe $HOME/${KEY_NAME}.pem, la reutilizo."
else
  echo "Creando key pair..."
  aws ec2 create-key-pair --key-name "$KEY_NAME" --region "$REGION" \
    --query 'KeyMaterial' --output text > "$HOME/${KEY_NAME}.pem"
  chmod 400 "$HOME/${KEY_NAME}.pem"
  echo "Guardada en $HOME/${KEY_NAME}.pem"
fi

# --- 2. VPC default ---
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text 2>/dev/null || true)
VPC_ID="${VPC_ID:-None}"

if [ "$VPC_ID" == "None" ] || [ -z "$VPC_ID" ]; then
  echo "ERROR: tu cuenta no tiene una VPC default en $REGION."
  echo "Crea una VPC (o pide que te ayude a adaptar el script a una VPC específica) y vuelve a correr."
  exit 1
fi
echo "VPC por default: $VPC_ID"

# --- 3. Security group (idempotente) ---
SG_ID=$(aws ec2 describe-security-groups --region "$REGION" \
  --filters Name=group-name,Values="$SG_NAME" Name=vpc-id,Values="$VPC_ID" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
SG_ID="${SG_ID:-None}"

if [ "$SG_ID" == "None" ] || [ -z "$SG_ID" ]; then
  echo "Creando security group..."
  SG_ID=$(aws ec2 create-security-group --region "$REGION" \
    --group-name "$SG_NAME" --description "Rutas Samsara: SSH/HTTP/HTTPS" --vpc-id "$VPC_ID" \
    --query 'GroupId' --output text)

  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --protocol tcp --port 22 --cidr 0.0.0.0/0 >/dev/null
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --protocol tcp --port 80 --cidr 0.0.0.0/0 >/dev/null
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null

  echo ""
  echo "AVISO: el puerto 22 (SSH) quedó abierto a cualquier IP (0.0.0.0/0)."
  echo "Cuando puedas, restríngelo a tu IP con:"
  echo "  aws ec2 revoke-security-group-ingress --region $REGION --group-id $SG_ID --protocol tcp --port 22 --cidr 0.0.0.0/0"
  echo "  aws ec2 authorize-security-group-ingress --region $REGION --group-id $SG_ID --protocol tcp --port 22 --cidr TU_IP/32"
  echo ""
else
  echo "Reutilizando security group existente: $SG_ID"
fi

# --- 4. AMI Ubuntu 22.04 más reciente ---
echo "Buscando la AMI de Ubuntu 22.04 más reciente..."
AMI_ID=$(aws ec2 describe-images --region "$REGION" \
  --owners 099720109477 \
  --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" \
            "Name=state,Values=available" \
  --query 'sort_by(Images, &CreationDate)[-1].ImageId' --output text)
echo "AMI: $AMI_ID"

# --- 5. Lanzar instancia (idempotente por tag Name) ---
INSTANCE_ID=$(aws ec2 describe-instances --region "$REGION" \
  --filters Name=tag:Name,Values="$INSTANCE_NAME" Name=instance-state-name,Values=pending,running \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || true)
INSTANCE_ID="${INSTANCE_ID:-None}"

if [ "$INSTANCE_ID" == "None" ] || [ -z "$INSTANCE_ID" ]; then
  echo "Lanzando instancia EC2 ($INSTANCE_TYPE)..."
  INSTANCE_ID=$(aws ec2 run-instances --region "$REGION" \
    --image-id "$AMI_ID" \
    --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" \
    --security-group-ids "$SG_ID" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$INSTANCE_NAME}]" \
    --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":20,"VolumeType":"gp3"}}]' \
    --query 'Instances[0].InstanceId' --output text)
  echo "Instancia creada: $INSTANCE_ID"
else
  echo "Ya hay una instancia corriendo con ese nombre: $INSTANCE_ID"
fi

echo "Esperando a que la instancia esté 'running'..."
aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"

PUBLIC_IP=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "IP pública: $PUBLIC_IP"

# --- 6. Esperar a que SSH responda ---
echo "Esperando a que SSH esté listo (puede tardar 1-2 minutos)..."
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -i "$HOME/${KEY_NAME}.pem")

LISTO=0
for i in $(seq 1 30); do
  if ssh "${SSH_OPTS[@]}" ubuntu@"$PUBLIC_IP" "echo ok" 2>/dev/null; then
    LISTO=1
    break
  fi
  sleep 10
done

if [ "$LISTO" -ne 1 ]; then
  echo "ERROR: SSH no respondió después de 5 minutos. Revisa la instancia manualmente."
  exit 1
fi
echo "SSH listo."

# --- 7. Copiar la app y el bootstrap; instalar Node/Postgres/nginx/pm2 ---
echo "Copiando la app a la instancia..."
scp "${SSH_OPTS[@]}" "$APP_ZIP" ubuntu@"$PUBLIC_IP":~/fleet-rutas-samsara.zip
scp "${SSH_OPTS[@]}" "$BOOTSTRAP_SCRIPT" ubuntu@"$PUBLIC_IP":~/remote-bootstrap.sh

echo "Instalando Node, Postgres, nginx, pm2 y dependencias de la app (varios minutos)..."
ssh "${SSH_OPTS[@]}" ubuntu@"$PUBLIC_IP" "chmod +x ~/remote-bootstrap.sh && sudo ~/remote-bootstrap.sh"

# --- 8. Secretos: se piden aquí en CloudShell, nunca se escriben en el historial de la instancia ---
echo ""
echo "=== Configuración de la app ==="
read -rp "Usuario para entrar al dashboard [admin]: " ADMIN_USER
ADMIN_USER="${ADMIN_USER:-admin}"
read -rsp "Contraseña para ese usuario: " ADMIN_PASSWORD
echo ""
read -rp "Tu SAMSARA_API_TOKEN: " SAMSARA_API_TOKEN

DB_PASSWORD=$(openssl rand -hex 16)
SESSION_SECRET=$(openssl rand -hex 32)

SECRETS_FILE=$(mktemp)
chmod 600 "$SECRETS_FILE"
{
  printf 'ADMIN_USER=%q\n' "$ADMIN_USER"
  printf 'ADMIN_PASSWORD=%q\n' "$ADMIN_PASSWORD"
  printf 'SAMSARA_API_TOKEN=%q\n' "$SAMSARA_API_TOKEN"
  printf 'DB_PASSWORD=%q\n' "$DB_PASSWORD"
  printf 'SESSION_SECRET=%q\n' "$SESSION_SECRET"
} > "$SECRETS_FILE"

scp "${SSH_OPTS[@]}" "$SECRETS_FILE" ubuntu@"$PUBLIC_IP":~/secrets.tmp
rm -f "$SECRETS_FILE"

echo "Configurando base de datos, .env, sembrando rutas, arrancando la app y nginx..."
scp "${SSH_OPTS[@]}" "$CONFIGURE_SCRIPT" ubuntu@"$PUBLIC_IP":~/remote-configure.sh
ssh "${SSH_OPTS[@]}" ubuntu@"$PUBLIC_IP" "chmod +x ~/remote-configure.sh && sudo ~/remote-configure.sh"

echo ""
echo "======================================================"
echo " Listo. Dashboard:   http://$PUBLIC_IP"
echo " Usuario:            $ADMIN_USER"
echo " Instancia:          $INSTANCE_ID"
echo " Llave SSH:          $HOME/${KEY_NAME}.pem"
echo " Entrar por SSH:     ssh -i $HOME/${KEY_NAME}.pem ubuntu@$PUBLIC_IP"
echo "======================================================"

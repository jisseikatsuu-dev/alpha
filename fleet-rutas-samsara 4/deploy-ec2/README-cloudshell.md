# Desplegar en EC2 desde AWS CloudShell

Esto automatiza todo el despliegue de EC2 corriendo un solo script dentro de
**AWS CloudShell** (la terminal con AWS CLI ya configurado que abres desde la
consola de AWS, icono `>_` arriba a la derecha).

Provisiona: la instancia EC2, el security group, Node.js, PostgreSQL, nginx,
pm2, sube tu app, la configura y la deja corriendo. Solo te va a pedir el
usuario/contraseña del dashboard y tu `SAMSARA_API_TOKEN` — esos nunca se
guardan en texto plano ni quedan en el historial de comandos.

## 1. Prepara los 3 archivos que necesitas subir

De este proyecto, necesitas subir a CloudShell:

- `fleet-rutas-samsara.zip` (el proyecto completo)
- `deploy-ec2/remote-bootstrap.sh`
- `deploy-ec2/remote-configure.sh`

(El cuarto, `deploy-cloudshell.sh`, también lo subes — es el que vas a correr.)

## 2. Abre AWS CloudShell

En la consola de AWS, da clic en el icono de terminal (`>_`) en la barra
superior. Espera a que inicialice (puede tardar ~1 minuto la primera vez).

## 3. Sube los archivos

En la ventana de CloudShell: **Actions (⋮ o "Actions" arriba) → Upload file**.
Sube uno por uno:

- `fleet-rutas-samsara.zip`
- `deploy-cloudshell.sh`
- `remote-bootstrap.sh`
- `remote-configure.sh`

Quedan en tu `$HOME` (algo como `/home/cloudshell-user/`).

## 4. Corre el script

```bash
chmod +x deploy-cloudshell.sh
./deploy-cloudshell.sh
```

El script va a:

1. Crear una key pair SSH (`rutas-samsara-key.pem`, guardada en tu `$HOME` de
   CloudShell — persiste entre sesiones porque CloudShell guarda tu home).
2. Crear un security group abriendo 22, 80 y 443.
3. Buscar la AMI de Ubuntu 22.04 más reciente.
4. Lanzar una instancia `t3.small`.
5. Esperar a que esté lista y a que SSH responda.
6. Copiar tu app y instalar Node, PostgreSQL, nginx y pm2.
7. **Pedirte en pantalla**: usuario/contraseña del dashboard y tu token de
   Samsara.
8. Crear la base de datos, el `.env`, sembrar las rutas, arrancar la app con
   pm2 y dejar nginx como proxy en el puerto 80.

Al final te imprime la URL pública, algo como:

```
Dashboard:   http://54.xxx.xxx.xxx
```

## 5. Notas importantes

- **Vuelve a correrlo si algo falla a medio camino**: el script es mayormente
  idempotente (reutiliza la key pair, el security group y la instancia si ya
  existen), así que puedes corregir un dato y volver a correr `./deploy-cloudshell.sh`.
- **El puerto 22 queda abierto a cualquier IP** por simplicidad. El script te
  imprime al final los dos comandos exactos para restringirlo a tu IP —
  ejecútalos cuando puedas.
- **CloudShell tiene un límite de tiempo de inactividad** (se desconecta solo
  tras ~20-30 min sin uso), pero eso no afecta a tu instancia EC2 una vez
  desplegada — sigue corriendo normal.
- **Para conectarte después por SSH**:
  ```bash
  ssh -i ~/rutas-samsara-key.pem ubuntu@<IP-PUBLICA>
  ```
- **Para actualizar la app más adelante** (subiste cambios nuevos): sube el
  nuevo `fleet-rutas-samsara.zip` a CloudShell y corre de nuevo
  `./deploy-cloudshell.sh` — detecta que la instancia ya existe y solo
  actualiza los archivos y reinicia la app. Ojo: te va a volver a pedir el
  usuario/contraseña/token (no los recuerda entre corridas); si no quieres
  cambiarlos, escribe los mismos valores.
- Si prefieres un dominio con HTTPS después, en la instancia corre `certbot`
  como se describe en la guía general de despliegue en EC2.

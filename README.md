# WA Sender — Multi-Session v3

Panel de administración para envío masivo de mensajes WhatsApp con múltiples números, autenticación JWT multi-usuario y aislamiento total de datos por cuenta.

---

## 🚀 Características

- **Multi-sesión** — conecta N cuentas de WhatsApp simultáneamente via QR
- **Envío masivo XLSX** — carga contactos desde Excel con variables dinámicas (`{{nombre}}`, `{{saldo}}`, etc.)
- **Anti-bloqueo** — delays aleatorios configurables entre mensajes
- **Reportería en tiempo real** — Socket.IO con historial persistido en SQLite
- **Autenticación JWT** — tokens de 24h, roles `superadmin` / `user`
- **Aislamiento total** — cada usuario solo ve sus propias sesiones y envíos
- **Listo para producción** — Docker, PM2, Helmet, rate-limiting

---

## 📦 Requisitos

| Herramienta | Versión mínima |
|-------------|---------------|
| Node.js     | 18.x o superior |
| npm         | 9.x o superior  |
| Google Chrome / Chromium | Cualquiera (para Puppeteer) |

---

## ⚙️ Configuración rápida (desarrollo)

```bash
# 1. Clona el repositorio
git clone https://github.com/tu-usuario/wa-sender.git
cd wa-sender

# 2. Crea el archivo de variables de entorno
cp .env.example .env
# Edita .env y cambia JWT_SECRET por un valor seguro

# 3. Instala dependencias
cd backend && npm install

# 4. Inicia el servidor
npm run dev
# → Abre http://localhost:3000
```

**Credenciales por defecto:**

| Usuario | Contraseña |
|---------|-----------|
| `superadmin` | `admin1234` |

> ⚠️ **Cambia la contraseña de superadmin inmediatamente desde el panel → Gestión de Usuarios.**

---

## 🌐 Despliegue en producción

### Opción A — PM2 (recomendado para VPS)

```bash
# Instalar PM2 globalmente
npm install -g pm2

# Crear archivo .env con tus valores reales
cp .env.example .env
nano .env   # ← pon JWT_SECRET real

# Instalar dependencias de producción
cd backend && npm ci --omit=dev

# Iniciar con PM2
cd ..
pm2 start ecosystem.config.js --env production

# Guardar para sobrevivir reinicios
pm2 save
pm2 startup   # sigue las instrucciones que imprime

# Comandos útiles
pm2 status
pm2 logs wa-sender
pm2 reload wa-sender   # recarga sin downtime
```

### Opción B — Docker Compose

```bash
# 1. Copia y edita .env
cp .env.example .env
# Genera un JWT_SECRET seguro:
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
# Pega el resultado en .env como JWT_SECRET=...

# 2. Construye y levanta
docker-compose up -d --build

# 3. Verifica
docker-compose ps
docker-compose logs -f wa-sender

# 4. Detener
docker-compose down
```

### Opción C — systemd (Linux puro)

```ini
# /etc/systemd/system/wa-sender.service
[Unit]
Description=WA Sender Multi-Session
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/wa-sender/backend
EnvironmentFile=/opt/wa-sender/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now wa-sender
sudo systemctl status wa-sender
```

---

## 🔒 Seguridad en producción

| Medida | Estado |
|--------|--------|
| JWT firmado (HS256, 24h) | ✅ |
| Contraseñas con bcrypt (cost 10) | ✅ |
| Rate limit en `/api/auth/login` (20 req/15min por IP) | ✅ |
| Helmet.js (headers HTTP seguros) | ✅ |
| Aislamiento de datos por `owner_id` | ✅ |
| `.gitignore` excluye credenciales y DB | ✅ |
| HTTPS (configura tu proxy inverso) | ⚠️ Ver abajo |

### HTTPS con Nginx (recomendado)

```nginx
server {
    listen 443 ssl;
    server_name tu-dominio.com;

    ssl_certificate     /etc/letsencrypt/live/tu-dominio.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tu-dominio.com/privkey.pem;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";  # para Socket.IO
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## 🗂️ Estructura del proyecto

```
wa-sender/
├── .env.example          # Plantilla de variables de entorno
├── .gitignore
├── Dockerfile
├── docker-compose.yml
├── ecosystem.config.js   # Configuración PM2
│
├── backend/
│   ├── server.js         # API REST + Socket.IO
│   ├── auth.js           # JWT + bcrypt + middlewares
│   ├── database.js       # SQLite (sql.js)
│   ├── sessionManager.js # Gestión de sesiones WhatsApp
│   ├── package.json
│   └── data/             # SQLite DB (excluida de git)
│       └── whatsapp_sender.db
│
└── frontend/
    ├── index.html        # Login + Dashboard SPA
    ├── app.js            # Lógica del cliente
    └── style.css         # Estilos dark mode
```

---

## 🔑 Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PORT` | `3000` | Puerto del servidor |
| `NODE_ENV` | `development` | Entorno (`production` activa optimizaciones) |
| `JWT_SECRET` | *inseguro* | **Cámbialo.** Secreto para firmar tokens JWT |
| `LOGIN_RATE_LIMIT` | `20` | Máx. intentos de login por IP en 15 min |

---

## 🩺 Health check

```bash
curl http://localhost:3000/api/health
# {"status":"ok","uptime":123.4,"dbReady":true,"ts":"2025-..."}
```

---

## 👥 Roles de usuario

| Acción | superadmin | user |
|--------|-----------|------|
| Ver todas las sesiones | ✅ | ❌ (solo las suyas) |
| Ver todos los batches | ✅ | ❌ (solo los suyos) |
| Gestionar usuarios | ✅ | ❌ |
| Crear sesiones | ✅ | ✅ |
| Envío masivo | ✅ | ✅ (con sus sesiones) |

---

## 📝 Licencia

MIT

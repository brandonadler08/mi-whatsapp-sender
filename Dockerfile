# ── Etapa base ────────────────────────────────────────────────────────────────
FROM node:20-slim AS base

# Dependencias del sistema para Puppeteer/Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Decirle a Puppeteer que use el Chromium del sistema
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# ── Dependencias ───────────────────────────────────────────────────────────────
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev

# ── Código fuente ──────────────────────────────────────────────────────────────
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# ── Volúmenes para datos persistentes ─────────────────────────────────────────
VOLUME ["/app/backend/data", "/app/backend/.wwebjs_auth"]

# ── Exposición y arranque ──────────────────────────────────────────────────────
EXPOSE 3000
WORKDIR /app/backend
CMD ["node", "server.js"]

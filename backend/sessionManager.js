
const pino = require('pino');
const qrcode = require('qrcode');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const aiService = require('./aiService');

class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.setMaxListeners(50);
  }

  async createSession(clientId, label = '', settings = {}) {
    if (this.sessions.has(clientId)) {
      throw new Error(`Session "${clientId}" already exists`);
    }

    const sessionData = {
      sock: null,
      status: 'initializing',
      phone: null,
      name: label || clientId,
      qr: null,
      proxy: settings.proxy || null,
      ai_enabled: !!settings.ai_enabled,
      ai_prompt: settings.ai_prompt || null,
      createdAt: new Date().toISOString()
    };
    this.sessions.set(clientId, sessionData);

    const authFolder = path.join(__dirname, 'data', 'auth', `session_${clientId}`);

    const startSock = async () => {
      const baileys = await import('@whiskeysockets/baileys');
      const makeWASocket = baileys.default?.makeWASocket || baileys.makeWASocket;
      const { useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = baileys;

      const { state, saveCreds } = await useMultiFileAuthState(authFolder);

      const { version } = await fetchLatestBaileysVersion();

      // Configurar Proxy si existe
      let agent;
      if (sessionData.proxy) {
        try {
          if (sessionData.proxy.startsWith('socks')) {
            agent = new SocksProxyAgent(sessionData.proxy);
          } else {
            agent = new HttpsProxyAgent(sessionData.proxy);
          }
        } catch (err) {
          console.error(`[${clientId}] Error al configurar proxy:`, err.message);
        }
      }

      const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.macOS('Desktop'),
        agent, // Inyectar el agente del proxy
      });

      sessionData.sock = sock;

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            const qrBase64 = await qrcode.toDataURL(qr);
            sessionData.qr = qrBase64;
            sessionData.status = 'qr_pending';
            this.emit('qr', { clientId, qr: qrBase64, label: sessionData.name });
            console.log(`[${clientId}] QR code generated (Baileys)`);
          } catch (err) {
            console.error(`[${clientId}] QR Error:`, err);
          }
        }

        if (connection === 'close') {
          const reason = lastDisconnect?.error?.output?.statusCode;
          if (reason === DisconnectReason.loggedOut) {
            sessionData.status = 'auth_failure';
            this.emit('auth_failure', { clientId, message: 'Sesión desvinculada', label: sessionData.name });
            console.error(`[${clientId}] Logged out. Auth failure.`);
            try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) { }
          } else {
            sessionData.status = 'disconnected';
            this.emit('disconnected', { clientId, reason: 'Reconectando', label: sessionData.name });
            console.log(`[${clientId}] Disconnected. Reconnecting...`);
            setTimeout(startSock, 3000); // Auto reconnect
          }
        }

        if (connection === 'open') {
          sessionData.status = 'ready';
          let jid = sock.user?.id || '';
          let phone = jid.split(':')[0] || jid.split('@')[0] || null;

          sessionData.phone = phone;
          sessionData.name = sock.user?.name || sessionData.name;

          this.emit('authenticated', { clientId, label: sessionData.name });
          this.emit('ready', { clientId, phone: sessionData.phone, name: sessionData.name });
          console.log(`[${clientId}] Ready (Baileys)! Phone: ${sessionData.phone}`);
        }
      });

      // ── Detectar Respuestas Entrantes ─────────────────────────────────────────
      sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        for (const msg of m.messages) {
          // Ignorar mensajes enviados por nosotros mismos o vacíos
          if (!msg.message || msg.key.fromMe) continue;

          const jid = msg.key.remoteJid;
          if (!jid || jid === 'status@broadcast') continue; // Ignorar estados

          const messageType = Object.keys(msg.message)[0];
          let textContent = '';

          if (messageType === 'conversation') {
            textContent = msg.message.conversation;
          } else if (messageType === 'extendedTextMessage') {
            textContent = msg.message.extendedTextMessage.text;
          } else if (messageType === 'imageMessage') {
            textContent = '[📷 Imagen recibida]';
            if (msg.message.imageMessage.caption) textContent += ` ${msg.message.imageMessage.caption}`;
          } else if (messageType === 'videoMessage') {
            textContent = '[🎥 Video recibido]';
            if (msg.message.videoMessage.caption) textContent += ` ${msg.message.videoMessage.caption}`;
          } else if (messageType === 'audioMessage') {
            textContent = '[🎤 Audio recibido]';
          } else if (messageType === 'documentMessage') {
            textContent = '[📄 Documento recibido]';
          } else if (messageType === 'stickerMessage') {
            textContent = '[🎫 Sticker recibido]';
          } else {
            textContent = `[${messageType} recibido]`;
          }

          const fromNumber = jid.split('@')[0];
          const authorName = msg.pushName || '';

          this.emit('new_reply', {
            id: msg.key.id,
            clientId,
            from_number: fromNumber,
            author_name: authorName,
            message_text: textContent,
            timestamp: new Date().toISOString()
          });
        }
      });

    };

    await startSock();
    return sessionData;
  }

  async removeSession(clientId) {
    const session = this.sessions.get(clientId);
    // Ya no arrojamos error si no está en memoria, así permitimos limpiar BD.

    try {
      if (session && session.sock) {
        session.sock.logout();
      }
    } catch (err) { }

    const authFolder = path.join(__dirname, 'data', 'auth', `session_${clientId}`);
    try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) { }

    this.sessions.delete(clientId);
    this.emit('session_removed', { clientId });
    console.log(`[${clientId}] Session removed`);
  }

  async sendMessage(clientId, to, message, imageBuffer = null, imageMimetype = null) {
    const session = this.sessions.get(clientId);
    if (!session) throw new Error(`Session "${clientId}" not found`);
    if (session.status !== 'ready') throw new Error(`Session "${clientId}" is not ready`);

    // Normalización: permitimos números de cualquier país
    const cleanTo = String(to).replace(/\D/g, '');

    if (!cleanTo || cleanTo.length < 8) {
      throw new Error(`Número inválido (${to})`);
    }

    // Envío directo sin búsqueda onWhatsApp (evita cuelgues)
    let jidPrimary = `${cleanTo}@s.whatsapp.net`;
    let jidFallback = null;

    // Lógica particular para México (52 vs 521)
    if (cleanTo.length === 13 && cleanTo.startsWith('521')) {
      jidFallback = `52${cleanTo.substring(3)}@s.whatsapp.net`;
    } else if (cleanTo.length === 12 && cleanTo.startsWith('52')) {
      jidFallback = `521${cleanTo.substring(2)}@s.whatsapp.net`;
    }

    let jid = jidPrimary;

    // --- Mejora Anti-Bloqueo: Simular Escritura ---
    await this.simulateTyping(clientId, jid, (message || '').length);

    let result;
    try {
      if (imageBuffer) {
        result = await session.sock.sendMessage(jid, {
          image: imageBuffer,
          caption: message || '',
          mimetype: imageMimetype || 'image/jpeg',
        });
      } else {
        result = await session.sock.sendMessage(jid, { text: message });
      }
    } catch (err) {
      if (!jidFallback) {
        throw new Error(`Error al enviar: ${err.message}`);
      }
      
      console.warn(`[${clientId}] Reintentando con JID fallback (${jidFallback})...`);
      jid = jidFallback;
      if (imageBuffer) {
        result = await session.sock.sendMessage(jid, {
          image: imageBuffer,
          caption: message || '',
          mimetype: imageMimetype || 'image/jpeg',
        });
      } else {
        result = await session.sock.sendMessage(jid, { text: message });
      }
    }

    return { success: true, messageId: result.key.id, chatId: jid };
  }

  /**
   * Simula escritura humana (Typing...)
   */
  async simulateTyping(clientId, jid, messageLength) {
    const session = this.sessions.get(clientId);
    if (!session || !session.sock) return;

    try {
      // 1. Activar estado "Escribiendo..."
      await session.sock.sendPresenceUpdate('composing', jid);

      // 2. Calcular delay: ~25ms por carácter (mínimo 1s, máximo 5s para no bloquear demasiado)
      const delay = Math.min(Math.max(messageLength * 25, 1000), 5000);

      await new Promise(r => setTimeout(r, delay));

      // 3. Quitar estado (opcional, Baileys lo quita al enviar el mensaje, pero es más seguro)
      await session.sock.sendPresenceUpdate('paused', jid);
    } catch (err) {
      console.warn(`[${clientId}] Error al simular escritura:`, err.message);
    }
  }

  sendPresenceUpdate(clientId, jid, presence) {
    const session = this.sessions.get(clientId);
    if (session && session.sock) {
      return session.sock.sendPresenceUpdate(presence, jid);
    }
  }

  async readMessages(clientId, jid, messageIds) {
    const session = this.sessions.get(clientId);
    if (session && session.sock) {
      try {
        const keys = messageIds.map(id => ({
          remoteJid: jid,
          id,
          fromMe: false
        }));
        await session.sock.readMessages(keys);
      } catch (err) {
        console.warn(`[${clientId}] Error al marcar como leído:`, err.message);
      }
    }
  }

  getSessions() {
    const list = [];
    for (const [clientId, data] of this.sessions) {
      list.push({
        clientId,
        status: data.status,
        phone: data.phone,
        name: data.name,
        createdAt: data.createdAt
      });
    }
    return list;
  }

  getSession(clientId) {
    return this.sessions.get(clientId) || null;
  }

  hasSession(clientId) {
    return this.sessions.has(clientId);
  }

  async handleAIAutoReply(clientId, fromNumber, userMessage) {
    const session = this.sessions.get(clientId);
    if (!session || !session.ai_enabled) return;

    try {
      const responseText = await aiService.generateResponse(userMessage, session.ai_prompt);
      if (responseText) {
        await this.sendMessage(clientId, fromNumber, responseText);
      }
    } catch (err) {
      console.error(`[AI ${clientId}] Error auto-Reply:`, err.message);
    }
  }

  /**
   * Verifica si un número tiene WhatsApp registrado.
   * No envía ningún mensaje. Solo consulta la API de WA.
   */
  async checkNumber(clientId, numero) {
    const session = this.sessions.get(clientId);
    if (!session) throw new Error(`Sesión "${clientId}" no encontrada`);
    if (session.status !== 'ready') throw new Error(`Sesión "${clientId}" no está lista`);

    // Normalizar a puros dígitos
    const cleanTo = String(numero).replace(/\D/g, '');

    if (!cleanTo || cleanTo.length < 8) {
      return { numero, normalized: null, exists: false, jid: null, error: `Número muy corto (${numero})` };
    }

    // Intentar con timeout para evitar cuelgues en bases grandes
    const withTimeout = (promise, ms) =>
      Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

    // Calcular variaciones a probar
    let variations = [`${cleanTo}@s.whatsapp.net`];

    // Lógica para México: probar ambas variantes para máxima compatibilidad
    if (cleanTo.length === 13 && cleanTo.startsWith('521')) {
      variations.push(`52${cleanTo.substring(3)}@s.whatsapp.net`);
    } else if (cleanTo.length === 12 && cleanTo.startsWith('52')) {
      variations.push(`521${cleanTo.substring(2)}@s.whatsapp.net`);
    }

    try {
      for (const v of variations) {
        const result = await withTimeout(session.sock.onWhatsApp(v), 8000);
        if (result && result.length > 0 && result[0].exists) {
          return { numero, normalized: cleanTo, exists: true, jid: result[0].jid };
        }
      }
      return { numero, normalized: cleanTo, exists: false, jid: null };
    } catch (err) {
      // En timeout o error: marcar como no verificado en lugar de bloquear
      return { numero, normalized: cleanTo, exists: false, jid: null, error: err.message === 'timeout' ? 'Tiempo de espera agotado' : err.message };
    }
  }
}


module.exports = SessionManager;

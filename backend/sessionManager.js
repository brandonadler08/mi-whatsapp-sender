
const pino = require('pino');
const qrcode = require('qrcode');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.setMaxListeners(50);
  }

  async createSession(clientId, label = '') {
    if (this.sessions.has(clientId)) {
      throw new Error(`Session "${clientId}" already exists`);
    }

    const sessionData = {
      sock: null,
      status: 'initializing',
      phone: null,
      name: label || clientId,
      qr: null,
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

      const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }), // Regresamos a silent
        printQRInTerminal: false,
        browser: Browsers.macOS('Desktop'),
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
          } catch(err) {
            console.error(`[${clientId}] QR Error:`, err);
          }
        }

        if (connection === 'close') {
          const reason = lastDisconnect?.error?.output?.statusCode;
          if (reason === DisconnectReason.loggedOut) {
            sessionData.status = 'auth_failure';
            this.emit('auth_failure', { clientId, message: 'Sesión desvinculada', label: sessionData.name });
            console.error(`[${clientId}] Logged out. Auth failure.`);
            try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
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
    } catch (err) {}

    const authFolder = path.join(__dirname, 'data', 'auth', `session_${clientId}`);
    try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}

    this.sessions.delete(clientId);
    this.emit('session_removed', { clientId });
    console.log(`[${clientId}] Session removed`);
  }

  async sendMessage(clientId, to, message) {
    const session = this.sessions.get(clientId);
    if (!session) throw new Error(`Session "${clientId}" not found`);
    if (session.status !== 'ready') throw new Error(`Session "${clientId}" is not ready`);

    // Normalización para 52 vs 521 (Mexico particularidad)
    const n = String(to).replace(/\D/g, ''); 
    let localN = n;
    if (n.length === 13 && n.startsWith('521')) localN = n.slice(3);  
    else if (n.length === 12 && n.startsWith('52'))  localN = n.slice(2);  
    else if (n.length === 11 && n.startsWith('1'))   localN = n.slice(1);  

    if(localN.length !== 10) throw new Error(`Número inválido (no tiene 10 dígitos)`);

    const variations = [`52${localN}@s.whatsapp.net`, `521${localN}@s.whatsapp.net`];
    let jid = variations[0];

    // Verificar si existe en WA usando onWhatsApp de Baileys
    try {
      for(let v of variations) {
        const lookup = await session.sock.onWhatsApp(v);
        if(lookup && lookup.length > 0 && lookup[0].exists) {
          jid = lookup[0].jid;
          break;
        }
      }
    } catch(err) {
      console.warn(`No se pudo resolver ${to}, usando JID por defecto.`);
    }

    const result = await session.sock.sendMessage(jid, { text: message });
    return { success: true, messageId: result.key.id, chatId: jid };
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
}

module.exports = SessionManager;

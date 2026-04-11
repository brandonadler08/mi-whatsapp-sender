// ── Load env vars first ───────────────────────────────────────────────────────
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// ── PROTECCIÓN GLOBAL CONTRA CAÍDAS ──────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('\n[CRITICAL ERROR] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('\n[CRITICAL ERROR] Unhandled Rejection at:', promise, 'reason:', reason);
});

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const auth = require('./auth');
const { applySpintax } = require('./utils/spintax');

// ── Database ───────────────────────────────────────────────────────────────────
let dbReady = false;
let dbModule = null;

async function initDb() {
  try {
    dbModule = require('./database');
    await dbModule.init();
    dbReady = true;
    console.log('✅ SQLite database ready at ./data/whatsapp_sender.db');
    // Ensure superadmin exists
    await auth.ensureSuperAdmin(dbModule.stmts);
  } catch (err) {
    console.warn('⚠️  SQLite not available — history will be in-memory only.');
    console.warn('   Details:', err.message);
  }
}

const SessionManager = require('./sessionManager');

const app = express();

// ── Trust proxy para Railway/Heroku/servidores en la nube ──────────────────────────
app.set('trust proxy', 1);

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST', 'DELETE'] }
});

const PORT = process.env.PORT || 3000;
const sessionManager = new SessionManager();

// ── In-memory live reports ────────────────────────────────────────────────────
const liveReports = [];
let rrIndex = 0;

// ── Control de procesos activos ────────────────────────────────────────────────
const bulkState = { running: false, batchId: null, stopRequested: false };

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function addReport(entry) {
  liveReports.unshift(entry);
  if (liveReports.length > 2000) liveReports.pop();
  io.emit('report:update', entry);
}

// ── Multer ────────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/\.(xlsx|xls)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Solo se aceptan archivos .xlsx o .xls'));
  }
});

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // permitir inline scripts del frontend
  crossOriginEmbedderPolicy: false,
}));
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// Middleware de Log de Peticiones
app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  next();
});

app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ── Rate limiting en login (anti-brute-force) ──────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,                               // 15 minutos
  max: parseInt(process.env.LOGIN_RATE_LIMIT) || 20, // máx intentos
  message: { error: 'Demasiados intentos. Intenta en 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Session Manager → Socket.IO ───────────────────────────────────────────────
sessionManager.on('qr', d => io.emit('session:qr', d));
sessionManager.on('authenticated', d => io.emit('session:authenticated', d));
sessionManager.on('ready', d => {
  io.emit('session:ready', d);

  // Verificar si la sesión ya tiene perfil de historial definido
  if (dbReady) {
    const profile = dbModule.stmts.getSessionProfile(d.clientId);
    if (!profile || profile.has_history === null || profile.has_history === undefined) {
      // Primera vez que se conecta — preguntar al admin si tiene historial
      setTimeout(() => {
        io.emit('session:needs_history_check', {
          clientId: d.clientId,
          name: d.name || d.clientId,
          phone: d.phone,
        });
      }, 1500); // pequeño delay para que el frontend procese el session:ready primero
    }
  }
});
sessionManager.on('disconnected', d => io.emit('session:disconnected', d));
sessionManager.on('auth_failure', d => io.emit('session:auth_failure', d));
sessionManager.on('session_removed', d => io.emit('session:removed', d));

// ── Lógica Asíncrona Masiva (Bandeja Inteligente) ────────────────────────────
const pendingPayloads = new Map();
const activeBatches = new Map();
const rrAsesores = {};

function prohibitAsesor(req, res, next) {
  if (req.user?.role === 'asesor') return res.status(403).json({ error: 'Acceso denegado para asesores' });
  next();
}

function checkBatchComplete(batchId) {
  const b = activeBatches.get(batchId);
  if (!b) return;
  if (b.done >= b.total) {
    if (dbReady) dbModule.stmts.completeBatch({
      id: batchId, sent: b.sent, errors: b.errors,
      completed_at: new Date().toISOString()
    });
    io.emit('bulk:complete', { batchId, batchName: b.name, total: b.total, sent: b.sent, errors: b.errors });
    console.log(`[Batch ${batchId}] ✅ Completed: ${b.sent} sent, ${b.errors} errors`);
    activeBatches.delete(batchId);
  }
}

async function executePayload(numero, isReply) {
  const job = pendingPayloads.get(numero);
  if (!job) return;

  pendingPayloads.delete(numero);
  clearTimeout(job.timeoutId);

  const { batchId, sessionClientId, mensajeFinal, entry } = job;
  const batch = activeBatches.get(batchId);

  if (!batch) return;

  try {
    // Simular latencia humana al responder (2 - 4.5 segundos)
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 2500));

    // --- Mejora Anti-Bloqueo: Simular Visto antes de enviar principal ---
    try {
      await sessionManager.readMessages(sessionClientId, `${numero}@s.whatsapp.net`, []);
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
    } catch (e) { }

    await sessionManager.sendMessage(sessionClientId, numero, mensajeFinal);
    entry.status = 'sent';
    entry.timestamp = new Date().toISOString();
    batch.sent++;
  } catch (err) {
    entry.status = 'error';
    entry.error = friendlyError(err.message);
    entry.timestamp = new Date().toISOString();
    batch.errors++;
  }

  batch.done++;

  if (dbReady) dbModule.stmts.updateMessage({
    id: entry.id, status: entry.status,
    error: entry.error || null, message_id: null,
    timestamp: entry.timestamp
  });

  addReport(entry);

  io.emit('bulk:progress', {
    batchId, batchName: batch.name,
    index: batch.done, total: batch.total,
    numero: entry.numero, cuenta: entry.cuenta, status: entry.status,
    error: entry.error, sessionUsed: entry.sessionUsed
  });

  checkBatchComplete(batchId);
}

sessionManager.on('new_reply', (replyData) => {
  let assignedAsesorId = null;
  if (dbReady) {
    const prevReply = dbModule.stmts.getLatestReplyFromNumber(replyData.clientId, replyData.from_number);
    if (prevReply && prevReply.asesor_id) {
      assignedAsesorId = prevReply.asesor_id;
    } else {
      const ownerId = dbModule.stmts.getSessionOwner(replyData.clientId);
      if (ownerId) {
        const asesores = dbModule.stmts.getAsesoresByOwner(ownerId);
        if (asesores.length > 0) {
          if (rrAsesores[ownerId] === undefined) rrAsesores[ownerId] = 0;
          let idx = rrAsesores[ownerId] % asesores.length;
          assignedAsesorId = asesores[idx].id;
          rrAsesores[ownerId]++;
        }
      }
    }

    const replyCount = dbModule.stmts.getReplyCountFromNumber(replyData.clientId, replyData.from_number);

    dbModule.stmts.insertReply({
      id: replyData.id,
      session_id: replyData.clientId,
      from_number: replyData.from_number,
      author_name: replyData.author_name,
      message_text: replyData.message_text,
      timestamp: replyData.timestamp,
      asesor_id: assignedAsesorId
    });

    // --- Inteligencia Artificial: Auto-Reply solo para CLIENTES NUEVOS (Temporalmente deshabilitado) ---
    /*
    if (replyCount === 0) {
      sessionManager.handleAIAutoReply(replyData.clientId, replyData.from_number, replyData.message_text);
    }
    */
  }
  replyData.asesor_id = assignedAsesorId;
  io.emit('reply:new', replyData);

  // ── Smart Bulk Reply Interception ──
  if (pendingPayloads.has(replyData.from_number)) {
    console.log(`[Inbox] Respuesta recibida de ${replyData.from_number}. Detonando envío diferido!`);
    executePayload(replyData.from_number, true);
  }
});

// ── Round-robin helper (respects owner) ──────────────────────────────────────
function getNextReadySession(ownerId = null) {
  let ready = sessionManager.getSessions().filter(s => s.status === 'ready');
  if (ownerId) {
    // filter to sessions owned by this user
    const owned = dbReady
      ? dbModule.stmts.getSessionsByOwner(ownerId).map(r => r.client_id)
      : [];
    ready = ready.filter(s => owned.includes(s.clientId));
  }
  if (ready.length === 0) return null;
  const session = ready[rrIndex % ready.length];
  rrIndex = (rrIndex + 1) % ready.length;
  return session;
}

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK (público — para Docker/load balancer)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), dbReady, ts: new Date().toISOString() });
});

// ─────────────────────────────────────────────────────────────────────────────
// VALIDADOR DE WHATSAPP
// ─────────────────────────────────────────────────────────────────────────────

// Validar un solo número
app.post('/api/check-number', auth.requireAuth, prohibitAsesor, async (req, res) => {
  const { clientId, numero } = req.body;
  if (!clientId || !numero)
    return res.status(400).json({ error: 'clientId y numero son requeridos' });

  const session = sessionManager.getSession(clientId);
  if (!session || session.status !== 'ready')
    return res.status(409).json({ error: 'La sesión no está disponible o no está conectada' });

  try {
    const result = await sessionManager.checkNumber(clientId, String(numero).trim());
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Validar múltiples números (resultado en tiempo real por Socket.io)
app.post('/api/check-numbers', auth.requireAuth, prohibitAsesor, async (req, res) => {
  const { clientId, numeros } = req.body;
  if (!clientId || !Array.isArray(numeros) || numeros.length === 0)
    return res.status(400).json({ error: 'clientId y numeros[] son requeridos' });
  if (numeros.length > 500)
    return res.status(400).json({ error: 'Máximo 500 números por lote' });

  const session = sessionManager.getSession(clientId);
  if (!session || session.status !== 'ready')
    return res.status(409).json({ error: 'La sesión no está disponible o no está conectada' });

  // Respuesta inmediata para no bloquear HTTP
  res.json({ success: true, total: numeros.length });

  // Procesar de forma asíncrona emitiendo progreso por socket
  (async () => {
    let withWA = 0;
    const results = [];
    for (let i = 0; i < numeros.length; i++) {
      const r = await sessionManager.checkNumber(clientId, String(numeros[i]).trim());
      if (r.exists) withWA++;
      results.push({ ...r, timestamp: new Date().toISOString() });

      io.emit('validator:progress', {
        index: i + 1,
        total: numeros.length,
        result: { ...r, timestamp: new Date().toISOString() }
      });

      // Delay anti-spam entre 700ms y 1.3s para no saturar WhatsApp
      if (i < numeros.length - 1) await sleep(700 + Math.floor(Math.random() * 600));
    }
    io.emit('validator:complete', {
      total: numeros.length,
      withWA,
      withoutWA: numeros.length - withWA,
      results
    });
  })();
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTH routes (public — no token required)
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'username y password son requeridos' });

  if (!dbReady)
    return res.status(503).json({ error: 'Base de datos no disponible' });

  const user = dbModule.stmts.getUserByUsername(username.trim());
  if (!user) return res.status(401).json({ error: 'Credenciales incorrectas' });

  const ok = await auth.verifyPassword(password, user.password);
  if (!ok) return res.status(401).json({ error: 'Credenciales incorrectas' });

  const token = auth.signToken(user);
  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role }
  });
});

app.get('/api/auth/me', auth.requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ─────────────────────────────────────────────────────────────────────────────
// USER MANAGEMENT (superadmin only)
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/users', auth.requireAuth, prohibitAsesor, (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });
  const parentId = req.user.role === 'superadmin' ? null : req.user.id;
  res.json({ users: dbModule.stmts.listUsers(parentId) });
});

app.post('/api/users', auth.requireAuth, prohibitAsesor, async (req, res) => {
  const { username, password, role } = req.body;
  if (!username?.trim() || !password)
    return res.status(400).json({ error: 'username y password son requeridos' });
  if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });

  let newRole = role === 'superadmin' ? 'superadmin' : (role === 'asesor' ? 'asesor' : 'admin');
  if (req.user.role === 'admin' && newRole !== 'asesor') newRole = 'asesor';

  const existing = dbModule.stmts.getUserByUsername(username.trim());
  if (existing) return res.status(409).json({ error: `Usuario "${username}" ya existe` });

  const hashed = await auth.hashPassword(password);
  const id = dbModule.stmts.createUser({
    username: username.trim(),
    password: hashed,
    role: newRole,
    parent_id: req.user.role === 'admin' ? req.user.id : null
  });
  res.json({ success: true, id });
});

app.delete('/api/users/:id', auth.requireAuth, prohibitAsesor, (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });
  if (req.params.id === req.user.id)
    return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });

  const targetUser = dbModule.stmts.getUserById(req.params.id);
  if (!targetUser) return res.status(404).json({ error: 'Usuario no encontrado' });

  if (req.user.role === 'admin' && targetUser.parent_id !== req.user.id) {
    return res.status(403).json({ error: 'No tienes permiso para eliminar este usuario' });
  }

  if (targetUser.role === 'superadmin')
    return res.status(400).json({ error: 'No se puede eliminar a un superadmin' });

  dbModule.stmts.deleteUser(req.params.id);
  res.json({ success: true });
});

// Change own password
app.post('/api/auth/change-password', auth.requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: 'currentPassword y newPassword son requeridos' });
  if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });

  const user = dbModule.stmts.getUserByUsername(req.user.username);
  const ok = await auth.verifyPassword(currentPassword, user.password);
  if (!ok) return res.status(401).json({ error: 'Contraseña actual incorrecta' });

  const hashed = await auth.hashPassword(newPassword);
  dbModule.stmts.updatePassword(req.user.id, hashed);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REST API — Sessions  [PROTECTED]
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/sessions', auth.requireAuth, prohibitAsesor, (_req, res) => {
  const { user } = _req;
  let sessions = sessionManager.getSessions();

  if (user.role !== 'superadmin' && dbReady) {
    const owned = dbModule.stmts.getSessionsByOwner(user.id).map(r => r.client_id);
    sessions = sessions.filter(s => owned.includes(s.clientId));
  }

  res.json({ sessions });
});

app.post('/api/sessions', auth.requireAuth, prohibitAsesor, async (req, res) => {
  const { clientId, label, proxy } = req.body;
  if (!clientId?.trim()) return res.status(400).json({ error: 'clientId es requerido' });

  const id = clientId.trim().replace(/[^a-zA-Z0-9_-]/g, '-');
  if (sessionManager.hasSession(id))
    return res.status(409).json({ error: `La sesión "${id}" ya existe` });

  /*
  // ── Auto-assign proxy if not provided ──
  let sessionProxy = proxy || null;
  if (!sessionProxy && dbReady) {
    sessionProxy = dbModule.stmts.getAvailableProxy(id);
  }
  */
  let sessionProxy = null;

  if (dbReady) {
    dbModule.stmts.insertSession({
      clientId: id,
      label: label || id,
      owner_id: req.user.id,
      // proxy: sessionProxy,
      created_at: new Date().toISOString()
    });
  }

  sessionManager.createSession(id, { label: label || id, proxy: sessionProxy }).catch(err => {
    io.emit('session:error', { clientId: id, error: err.message });
  });

  res.json({ success: true, clientId: id, proxyUsed: sessionProxy });
});

app.delete('/api/sessions/:id', auth.requireAuth, prohibitAsesor, async (req, res) => {
  const { user } = req;
  const sid = req.params.id;

  // Ownership check for non-superadmin
  if (user.role !== 'superadmin' && dbReady) {
    const ownerId = dbModule.stmts.getSessionOwner(sid);
    if (ownerId !== user.id)
      return res.status(403).json({ error: 'No tienes permiso para eliminar esta sesión' });
  }

  try {
    await sessionManager.removeSession(sid);
    if (dbReady) {
      dbModule.stmts.releaseProxy(sid);
      dbModule.stmts.deleteSession(sid);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ── Configuración Avanzada (IA / Proxy) ───────────────────────────────────────
app.post('/api/sessions/:clientId/settings', auth.requireAuth, prohibitAsesor, (req, res) => {
  const { clientId } = req.params;
  const { ai_enabled, ai_prompt, proxy } = req.body;
  const { user } = req;

  // Verificar propiedad
  const ownerId = dbModule.stmts.getSessionOwner(clientId);
  if (user.role !== 'superadmin' && ownerId !== user.id) {
    return res.status(403).json({ error: 'No tienes permiso' });
  }

  const session = sessionManager.sessions.get(clientId);
  if (session) {
    session.ai_enabled = !!ai_enabled;
    session.ai_prompt = ai_prompt;
    session.proxy = proxy;
  }

  if (dbReady) {
    dbModule.stmts.updateSessionAI(clientId, ai_enabled, ai_prompt);
    dbModule.stmts.updateSessionProxy(clientId, proxy);
    dbModule.stmts.updateProxySession(clientId, proxy);
  }

  res.json({ success: true, message: 'Configuración guardada. Reinicia la sesión para aplicar cambios de Proxy.' });
});

// ── Perfil de historial de sesión ─────────────────────────────────────────────
app.get('/api/sessions/:clientId/profile', auth.requireAuth, prohibitAsesor, (req, res) => {
  const { clientId } = req.params;
  if (!dbReady) return res.json({ has_history: null, history_level: 0 });
  const profile = dbModule.stmts.getSessionProfile(clientId);
  res.json(profile || { client_id: clientId, has_history: null, history_level: 0 });
});

// ── Marcar historial de sesión (nuevo vs con historial) ────────────────────────
app.put('/api/sessions/:clientId/history', auth.requireAuth, prohibitAsesor, (req, res) => {
  const { clientId } = req.params;
  const { hasHistory } = req.body; // true = tiene historial, false = número nuevo

  if (typeof hasHistory !== 'boolean')
    return res.status(400).json({ error: 'hasHistory (boolean) es requerido' });

  if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });

  // Nivel automático según historial
  // Nuevo (false) → nivel 0 (necesita entrenamiento primero)
  // Con historial (true) → nivel 1 (permite hasta 50 msgs/día)
  const historyLevel = hasHistory ? 1 : 0;

  dbModule.stmts.updateSessionHistory(clientId, hasHistory, historyLevel);

  // Actualizar los límites en memoria del trainingLocks si aplica
  const session = sessionManager.sessions.get(clientId);
  if (session) {
    session.hasHistory = hasHistory;
    session.historyLevel = historyLevel;
  }

  // Emitir evento para que el frontend se actualice
  io.emit('session:history_set', {
    clientId,
    hasHistory,
    historyLevel,
    dailyLimit: hasHistory ? 50 : 0, // 0 = bloqueado para bulk hasta completar entrenamiento
    label: session?.name || clientId
  });

  const msg = hasHistory
    ? `✅ Sesión marcada con historial (Nivel 1: hasta 50 msgs/día)`
    : `🏋️ Sesión marcada como nueva — se iniciará entrenamiento`;

  console.log(`[History] ${clientId}: ${msg}`);
  res.json({ success: true, hasHistory, historyLevel, message: msg });
});

// ── Single send ───────────────────────────────────────────────────────────────
app.post('/api/send', auth.requireAuth, async (req, res) => {
  const { clientId, to, message } = req.body;
  if (!clientId || !to || !message)
    return res.status(400).json({ error: 'clientId, to y message son requeridos' });

  // Ownership check
  if (req.user.role !== 'superadmin' && dbReady) {
    if (req.user.role === 'asesor') {
      const prevReply = dbModule.stmts.getLatestReplyFromNumber(clientId, to);
      if (!prevReply || prevReply.asesor_id !== req.user.id) {
        return res.status(403).json({ error: 'No tienes permiso para responder a este número en esta sesión' });
      }
    } else {
      const ownerId = dbModule.stmts.getSessionOwner(clientId);
      if (ownerId !== req.user.id)
        return res.status(403).json({ error: 'No tienes permiso para usar esta sesión' });
    }
  }

  // Resolver imagen si se adjuntó
  let imageBuffer = null;
  let imageMimetype = null;
  if (imageKey) {
    const img = imageStore.get(imageKey);
    if (img) {
      imageBuffer = img.buffer;
      imageMimetype = img.mimetype;
    }
  }

  try {
    const result = await sessionManager.sendMessage(clientId, to, message, imageBuffer, imageMimetype);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// REST API — Replies (Inbox)  [PROTECTED]
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/replies', auth.requireAuth, (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });
  const { user } = req;

  let ownerId = null;
  let asesorId = null;
  if (user.role === 'admin') ownerId = user.id;
  else if (user.role === 'asesor') asesorId = user.id;

  const replies = dbModule.stmts.getReplies(ownerId, 1000, asesorId);
  const unreadCount = dbModule.stmts.getUnreadRepliesCount(ownerId);
  res.json({ success: true, replies, unreadCount });
});

app.put('/api/replies/:id/read', auth.requireAuth, (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });
  const id = req.params.id;

  if (id === 'all') {
    const ownerId = req.user.role !== 'superadmin' ? req.user.id : null;
    dbModule.stmts.markAllRepliesRead(ownerId);
  } else {
    dbModule.stmts.markReplyRead(id);
  }
  res.json({ success: true });
});

// ── CRM Inbox: Sesiones con badge de no leídos ─────────────────────────────
app.get('/api/inbox/sessions', auth.requireAuth, (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });
  const { user } = req;

  // Obtener todas las sesiones ready del manager
  const allSessions = sessionManager.getSessions();
  let sessions = allSessions;
  if (user.role === 'admin' && dbReady) {
    const owned = dbModule.stmts.getSessionsByOwner(user.id).map(r => r.client_id);
    sessions = allSessions.filter(s => owned.includes(s.clientId));
  }

  // Para cada sesión, buscar cuántos no leídos tiene
  const result = sessions.map(s => {
    let unread = 0;
    let lastMsg = null;
    let lastTime = null;
    try {
      const contacts = dbModule.stmts.getReplyContacts ?
        dbModule.stmts.getReplyContacts(s.clientId, user.role === 'admin' ? user.id : null, 1000) : [];
      unread = contacts.filter(c => c.unread_count > 0).reduce((a, c) => a + (c.unread_count || 0), 0);
      if (contacts.length > 0) {
        lastMsg = contacts[0].last_message;
        lastTime = contacts[0].last_time;
      }
    } catch (e) { /* ignorar si no existe la función */ }
    return {
      clientId: s.clientId,
      name: s.name || s.clientId,
      phone: s.phone,
      status: s.status,
      unread,
      lastMsg,
      lastTime,
    };
  });

  res.json({ sessions: result });
});

// ── CRM Inbox: Contactos de una sesión (columna 2) ─────────────────────────
app.get('/api/inbox/contacts', auth.requireAuth, (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });
  const { clientId, search } = req.query;
  if (!clientId) return res.status(400).json({ error: 'clientId requerido' });

  const ownerId = req.user.role === 'admin' ? req.user.id : null;

  let contacts = [];
  try {
    if (dbModule.stmts.getReplyContacts) {
      contacts = dbModule.stmts.getReplyContacts(clientId, ownerId, 500);
    } else {
      // Fallback: agrupar replies por número
      const replies = dbModule.stmts.getReplies(ownerId, 2000, null);
      const grouped = {};
      replies.filter(r => r.session_id === clientId).forEach(r => {
        if (!grouped[r.from_number]) {
          grouped[r.from_number] = { from_number: r.from_number, last_message: r.message, last_time: r.received_at, unread_count: 0, tag: r.tag || null };
        }
        if (!r.is_read) grouped[r.from_number].unread_count++;
      });
      contacts = Object.values(grouped).sort((a, b) => new Date(b.last_time) - new Date(a.last_time));
    }
  } catch (e) { console.error('[inbox/contacts]', e.message); }

  if (search) {
    const q = search.toLowerCase();
    contacts = contacts.filter(c => c.from_number?.includes(q) || c.cuenta?.toLowerCase().includes(q));
  }

  res.json({ contacts });
});

// ── CRM Inbox: Hilo de conversación (columna 3) ───────────────────────────
app.get('/api/inbox/conversation', auth.requireAuth, (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });
  const { clientId, from } = req.query;
  if (!clientId || !from) return res.status(400).json({ error: 'clientId y from requeridos' });

  // Marcar como leídos al abrir
  try {
    dbModule.stmts.markConversationRead(clientId, from);
  } catch (e) { /* puede no existir */ }

  // Obtener mensajes enviados a este número desde messages + replies recibidos
  let sent = [];
  let received = [];
  try {
    if (dbModule.stmts.getConversationMessages) {
      const all = dbModule.stmts.getConversationMessages(clientId, from);
      res.json({ messages: all });
      return;
    }
    // Fallback: combinar manualmente
    const allReplies = dbModule.stmts.getReplies(null, 500, null);
    received = allReplies
      .filter(r => r.session_id === clientId && r.from_number === from)
      .map(r => ({ ...r, direction: 'in', ts: r.received_at }));

    const allMessages = dbModule.stmts.getMessagesByNumber ? dbModule.stmts.getMessagesByNumber(clientId, from) : [];
    sent = allMessages.map(m => ({ ...m, direction: 'out', ts: m.timestamp }));
  } catch (e) { console.error('[inbox/conversation]', e.message); }

  const combined = [...received, ...sent].sort((a, b) => new Date(a.ts) - new Date(b.ts));
  res.json({ messages: combined });
});

// ── CRM Inbox: Etiquetar conversación ─────────────────────────────────────
app.put('/api/inbox/tag', auth.requireAuth, (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });
  const { clientId, fromNumber, tag } = req.body;
  if (!clientId || !fromNumber) return res.status(400).json({ error: 'clientId y fromNumber requeridos' });

  const validTags = ['sinEtiqueta', 'interesado', 'noInteresado', 'seguimiento', 'cerrado'];
  if (tag && !validTags.includes(tag)) return res.status(400).json({ error: 'Etiqueta inválida' });

  try {
    if (dbModule.stmts.tagConversation) {
      dbModule.stmts.tagConversation(clientId, fromNumber, tag || null);
    }
    io.emit('inbox:tagged', { clientId, fromNumber, tag });
    res.json({ success: true, tag });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CRM Inbox: Archivar/Eliminar mensaje ─────────────────────────────────
app.delete('/api/inbox/reply/:id', auth.requireAuth, (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });
  const { id } = req.params;
  try {
    if (dbModule.stmts.deleteReply) dbModule.stmts.deleteReply(id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});



// ═══════════════════════════════════════════════════════════════════════════════
// REST API — XLSX parse  [PROTECTED]
// ═══════════════════════════════════════════════════════════════════════════════
const SYSTEM_COLS = new Set(['numero', 'cuenta']);

app.post('/api/parse-xlsx', auth.requireAuth, prohibitAsesor, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });

  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(ws, { defval: '' });

    if (raw.length === 0) return res.status(422).json({ error: 'El archivo está vacío' });

    const allKeys = Object.keys(raw[0]).map(k => k.toLowerCase().trim());
    const variableCols = allKeys.filter(k => !SYSTEM_COLS.has(k));

    const errors = [];
    const parsed = raw.map((r, i) => {
      const row = {};
      for (const [k, v] of Object.entries(r)) {
        row[k.toLowerCase().trim()] = String(v).trim();
      }
      const rowNum = i + 2;
      if (!row.numero) { errors.push(`Fila ${rowNum}: falta columna "numero"`); return null; }
      const n10 = normalizeMx10(row.numero);
      if (!n10) { errors.push(`Fila ${rowNum}: "${row.numero}" no es válido`); return null; }
      return { ...row, numero: n10 };
    }).filter(Boolean);

    res.json({
      success: true, total: parsed.length,
      skipped: raw.length - parsed.length,
      variableCols, errors: errors.slice(0, 20), rows: parsed
    });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// REST API — Bulk send  [PROTECTED]
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/send-bulk-xlsx', auth.requireAuth, prohibitAsesor, async (req, res) => {
  const { rows, clientId, minDelay, maxDelay, template, batchName, warmup, imageKey,
          dailyLimit, coolingEvery, coolingSecs } = req.body;
  const { user } = req;

  if (!rows || !Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ error: 'rows requerido' });
  if (!clientId)
    return res.status(400).json({ error: 'clientId requerido' });
  if (!template?.trim())
    return res.status(400).json({ error: 'La plantilla del mensaje es requerida' });

  const useRotation = clientId === 'ALL';
  // Delays ahora vienen en SEGUNDOS desde la UI; convertir a ms
  const dMin = Math.max(10000, (parseInt(minDelay) || 20) * 1000);
  const dMax = Math.min(300000, (parseInt(maxDelay) || 45) * 1000);
  const maxPerDay  = Math.max(10, parseInt(dailyLimit)  || 150);
  const coolEvery  = Math.max(5,  parseInt(coolingEvery) || 30);
  const coolMs     = Math.max(30000, (parseInt(coolingSecs) || 120) * 1000);
  const batchId = genId();
  const batchCreated = new Date().toISOString();
  const name = batchName?.trim() || `Envío ${new Date().toLocaleString('es-MX')}`;

  // Validate sessions (scoped to owner for non-superadmin)
  let readySessions = sessionManager.getSessions().filter(s => s.status === 'ready');
  if (user.role !== 'superadmin' && dbReady) {
    const owned = dbModule.stmts.getSessionsByOwner(user.id).map(r => r.client_id);
    readySessions = readySessions.filter(s => owned.includes(s.clientId));
  }
  if (readySessions.length === 0)
    return res.status(409).json({ error: 'No hay sesiones conectadas disponibles' });
  if (!useRotation && !sessionManager.hasSession(clientId))
    return res.status(404).json({ error: `Sesión "${clientId}" no encontrada` });

  // Ownership check for single session
  if (!useRotation && user.role !== 'superadmin' && dbReady) {
    const ownerId = dbModule.stmts.getSessionOwner(clientId);
    if (ownerId !== user.id)
      return res.status(403).json({ error: 'No tienes permiso para usar esta sesión' });
  }

  // Verificar bloqueo de maduración (entrenamiento en curso o periodo de espera)
  if (!useRotation) {
    const lock = isSessionLocked(clientId);
    if (lock) {
      const remH = Math.ceil((lock.unlocksAt - Date.now()) / 3600000);
      return res.status(423).json({
        error: `🔒 La sesión "${clientId}" está en período de maduración post-entrenamiento (${remH}h restantes). Usa otra sesión o espera a que termine el período.`
      });
    }
  }

  if (dbReady) {
    dbModule.stmts.insertBatch({
      id: batchId, name, total: rows.length,
      session_mode: useRotation ? 'ALL' : clientId,
      delay_ms: dMin, template: String(template || '').slice(0, 5000),
      owner_id: user.id,
      created_at: batchCreated
    });
  }

  res.json({ success: true, batchId, total: rows.length });

  // Resolver imagen del imageStore ANTES del loop asíncrono
  let bulkImageBuffer = null;
  let bulkImageMimetype = null;
  if (imageKey) {
    const img = imageStore.get(imageKey);
    if (img) {
      bulkImageBuffer = img.buffer;
      bulkImageMimetype = img.mimetype;
      console.log(`[Bulk ${batchId}] Usando imagen adjunta: ${img.name}`);
    }
  }

  // ── Async bulk send ───────────────────────────────────────────────────────
  (async () => {
    bulkState.running = true;
    bulkState.batchId = batchId;
    bulkState.stopRequested = false;

    // Contadores de mensajes por sesión (para enfriamiento y límite diario)
    const sessionCounters = {}; // clientId -> { today: N, sinceCooling: N }

    activeBatches.set(batchId, {
      name: name,
      total: rows.length,
      done: 0,
      sent: 0,
      errors: 0
    });

    for (let i = 0; i < rows.length; i++) {
      // ── Chequeo de detención ──
      if (bulkState.stopRequested) {
        console.log(`[Bulk ${batchId}] ⏹️ Detenido por usuario en fila ${i + 1}/${rows.length}`);
        io.emit('bulk:stopped', { batchId, batchName: name, doneAt: i, total: rows.length });
        break;
      }
      const { numero, cuenta } = row;
      const mensajeFinal = applySpintax(applyTemplate(template, row));

      let session;
      if (useRotation) {
        // Buscar sesión disponible que no haya superado el límite diario
        const allReady = sessionManager.getSessions().filter(s => s.status === 'ready');
        session = allReady.find(s => {
          const c = sessionCounters[s.clientId];
          return !c || c.today < maxPerDay;
        }) || null;
        // Si todas han superado el límite diario, tomar la con menos mensajes
        if (!session && allReady.length > 0) {
          session = allReady.sort((a, b) =>
            (sessionCounters[a.clientId]?.today || 0) - (sessionCounters[b.clientId]?.today || 0)
          )[0];
        }
        if (!session) {
          const entry = makeEntry(batchId, row, mensajeFinal, '—', 'error', 'Sin sesiones disponibles');
          addReport(entry);
          if (dbReady) dbModule.stmts.insertMessage({
            id: entry.id, batch_id: batchId, numero: entry.numero, cuenta: entry.cuenta,
            mensaje_final: entry.mensaje, session_used: entry.sessionUsed,
            status: entry.status, error: entry.error, timestamp: entry.timestamp
          });
          const batch = activeBatches.get(batchId);
          batch.errors++; batch.done++;
          checkBatchComplete(batchId);
          continue;
        }
      } else {
        const s = sessionManager.getSession(clientId);
        session = s ? { clientId, name: s.name } : null;
        if (!session) {
          const entry = makeEntry(batchId, row, mensajeFinal, clientId, 'error', 'Sesión no encontrada');
          addReport(entry);
          if (dbReady) dbModule.stmts.insertMessage({
            id: entry.id, batch_id: batchId, numero: entry.numero, cuenta: entry.cuenta,
            mensaje_final: entry.mensaje, session_used: entry.sessionUsed,
            status: entry.status, error: entry.error, timestamp: entry.timestamp
          });
          const batch = activeBatches.get(batchId);
          batch.errors++; batch.done++;
          checkBatchComplete(batchId);
          continue;
        }
      }

      // ── Actualizar contadores por sesión ──
      const sid = session.clientId || session.name;
      if (!sessionCounters[sid]) sessionCounters[sid] = { today: 0, sinceCooling: 0 };
      sessionCounters[sid].today++;
      sessionCounters[sid].sinceCooling++;

      // ── Pausa de enfriamiento ──
      if (sessionCounters[sid].sinceCooling >= coolEvery) {
        sessionCounters[sid].sinceCooling = 0;
        const coolMin = Math.round(coolMs / 60000);
        console.log(`[Bulk ${batchId}] 🧐 Sesión ${sid} enfriándose ${coolMin}min después de ${coolEvery} mensajes`);
        io.emit('bulk:cooling', { batchId, sessionId: sid, coolMs, index: i + 1, total: rows.length });
        await sleep(coolMs);
      }

      // ── Advertencia de límite diario ──
      if (sessionCounters[sid].today >= maxPerDay) {
        console.warn(`[Bulk ${batchId}] ⚠️ Sesión ${sid} alcanzó el límite de ${maxPerDay} msgs/día`);
        io.emit('bulk:daily_limit', { batchId, sessionId: sid, limit: maxPerDay });
      }

      const entry = makeEntry(batchId, row, mensajeFinal, session.name || session.clientId, 'pending', null);

      if (dbReady) dbModule.stmts.insertMessage({
        id: entry.id, batch_id: batchId,
        numero: entry.numero, cuenta: entry.cuenta,
        mensaje_final: entry.mensaje,
        session_used: entry.sessionUsed,
        status: 'pending',
        timestamp: entry.timestamp
      });

      // Flujo de Inteligencia
      try {
        let sentWarmup = false;
        if (warmup) {
          const hr = new Date().getHours();
          let saludo = 'Buenos días';
          if (hr >= 12 && hr < 19) saludo = 'Buenas tardes';
          else if (hr >= 19 || hr < 5) saludo = 'Buenas noches';

          const warmupText = applyTemplate(`${saludo} {{nombre}}`, row);
          await sessionManager.sendMessage(session.clientId, numero, warmupText);
          sentWarmup = true;
          io.emit('bulk:waiting', { batchId, index: i + 1, total: rows.length, waitMs: randomDelay(2000, 4000) });
        }

        // Poner en espera de 7 minutos en segundo plano
        if (sentWarmup) {
          const tId = setTimeout(() => {
            executePayload(numero, false);
          }, 7 * 60 * 1000);

          pendingPayloads.set(numero, {
            batchId, sessionClientId: session.clientId, mensajeFinal, entry, timerId: tId,
            imageBuffer: bulkImageBuffer, imageMimetype: bulkImageMimetype
          });
        } else {
          // Si apagó "warmup", enviamos el mensaje principal directamente
          const tId = setTimeout(() => executePayload(numero, false), 500);
          pendingPayloads.set(numero, {
            batchId, sessionClientId: session.clientId, mensajeFinal, entry, timerId: tId,
            imageBuffer: bulkImageBuffer, imageMimetype: bulkImageMimetype
          });
        }

      } catch (err) {
        entry.status = 'error';
        entry.error = friendlyError(err.message);
        entry.timestamp = new Date().toISOString();

        if (dbReady) dbModule.stmts.updateMessage({
          id: entry.id, status: entry.status,
          error: entry.error, message_id: null,
          timestamp: entry.timestamp
        });
        addReport(entry);

        const batch = activeBatches.get(batchId);
        if (batch) {
          batch.errors++; batch.done++;
          io.emit('bulk:progress', {
            batchId, batchName: name, index: batch.done, total: batch.total,
            numero, cuenta, status: entry.status, error: entry.error, sessionUsed: entry.sessionUsed
          });
          checkBatchComplete(batchId);
        }
      }

      if (i < rows.length - 1 && !bulkState.stopRequested) {
        const waitMs = randomDelay(dMin, dMax);
        io.emit('bulk:waiting', { batchId, index: i + 1, total: rows.length, waitMs });
        await sleep(waitMs);
      }
    }

    bulkState.running = false;
    bulkState.batchId = null;
    bulkState.stopRequested = false;

    // Todos los saludos enviados, o procesados hasta fase pendiente.
    io.emit('bulk:greetings_done', { batchId, batchName: name, total: rows.length });

  })();
});

// Detener el envío masivo en curso
app.post('/api/send-bulk-xlsx/stop', auth.requireAuth, prohibitAsesor, (req, res) => {
  if (!bulkState.running) {
    return res.status(409).json({ error: 'No hay ningún envío masivo en curso' });
  }
  bulkState.stopRequested = true;
  // Cancelar también los payloads pendientes (warmup timers)
  pendingPayloads.forEach((payload, numero) => {
    clearTimeout(payload.timerId);
    pendingPayloads.delete(numero);
  });
  console.log(`[Bulk] ⏹️ Detención solicitada por ${req.user.username}`);
  res.json({ success: true, message: 'Detención solicitada. El proceso terminará después del mensaje actual.' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REST API — Live reports  [PROTECTED]
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/reports', auth.requireAuth, prohibitAsesor, (req, res) => {
  const { batchId, status, limit = 500 } = req.query;
  const { user } = req;
  let result = liveReports;
  if (batchId) result = result.filter(r => r.batchId === batchId);
  if (status) result = result.filter(r => r.status === status);
  res.json({ total: result.length, reports: result.slice(0, parseInt(limit)) });
});

app.delete('/api/reports', auth.requireAuth, prohibitAsesor, (_req, res) => {
  liveReports.length = 0;
  io.emit('report:cleared');
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REST API — History (SQLite)  [PROTECTED]
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/history', auth.requireAuth, prohibitAsesor, (req, res) => {
  if (!dbReady) return res.json({ dbReady: false, batches: [] });
  const { user } = req;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const ownerId = user.role === 'superadmin' ? null : user.id;
  const batches = dbModule.stmts.getBatches(limit, ownerId);
  res.json({ dbReady: true, batches });
});

app.get('/api/history/stats', auth.requireAuth, prohibitAsesor, (req, res) => {
  if (!dbReady) return res.json({ dbReady: false });
  const { user } = req;
  const ownerId = user.role === 'superadmin' ? null : user.id;
  const stats = dbModule.stmts.getTotalStats(ownerId);
  res.json({ dbReady: true, ...stats });
});

app.get('/api/history/:batchId', auth.requireAuth, prohibitAsesor, (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });
  const { user } = req;
  const ownerId = user.role === 'superadmin' ? null : user.id;

  const batch = dbModule.stmts.getBatch(req.params.batchId, ownerId);
  if (!batch) return res.status(404).json({ error: 'Lote no encontrado o sin acceso' });

  const { status } = req.query;
  const messages = status
    ? dbModule.stmts.getMessagesFiltered(req.params.batchId, status)
    : dbModule.stmts.getMessages(req.params.batchId);

  res.json({ batch, messages });
});

app.delete('/api/history/:batchId', auth.requireAuth, prohibitAsesor, (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });
  const { user } = req;
  const ownerId = user.role === 'superadmin' ? null : user.id;

  const batch = dbModule.stmts.getBatch(req.params.batchId, ownerId);
  if (!batch) return res.status(404).json({ error: 'Lote no encontrado o sin acceso' });

  try {
    dbModule.deleteBatchFull(req.params.batchId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history/:batchId/csv', auth.requireAuth, prohibitAsesor, (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });
  const { user } = req;
  const ownerId = user.role === 'superadmin' ? null : user.id;

  const batch = dbModule.stmts.getBatch(req.params.batchId, ownerId);
  if (!batch) return res.status(404).json({ error: 'Lote no encontrado o sin acceso' });

  const messages = dbModule.stmts.getMessages(req.params.batchId);
  const headers = ['#', 'Numero', 'Cuenta', 'Mensaje', 'Sesion', 'Estado', 'Error', 'Hora'];
  const lines = ['\uFEFF' + headers.join(',')];

  messages.forEach((m, i) => {
    lines.push([
      i + 1, csvVal(m.numero), csvVal(m.cuenta), csvVal(m.mensaje_final),
      csvVal(m.session_used), m.status, csvVal(m.error || ''),
      csvVal(m.timestamp ? new Date(m.timestamp).toLocaleString('es-MX') : '')
    ].join(','));
  });

  const filename = `batch_${batch.id}_${batch.name.replace(/[^a-z0-9]/gi, '_').slice(0, 30)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(lines.join('\n'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// TRAINING MODE  [PROTECTED — superadmin only]
// ═══════════════════════════════════════════════════════════════════════════════

// ── Banco de mensajes naturales para simular conversación ─────────────────────
const TRAINING_MESSAGES = [
  // Respuestas cortas y naturales (muy importantes para parecer humano)
  'Ok!', 'Va!', 'Claro', 'Sí claro', 'Ahora te marco', 'Espera tantito',
  'Ya vi, gracias!', 'Listo 👌', 'De acuerdo', 'No hay bronca',
  'Jajaj sí, así es', 'Exacto!', 'Qué buena onda', 'Perfecto!',
  // Saludos y plática general
  'Hola! 👋 ¿Cómo vas con el proyecto? Me quedé pensando en lo que platicamos ayer.',
  'Buenos días! Espero que todo esté bien. ¿A qué hora podemos revisar los detalles?',
  'Buenas tardes 😊. Te mandé un correo con la propuesta actualizada, ¿lo pudiste checar?',
  'Hola qué tal, ¿cómo va tu semana? Yo aquí terminando unas cosas pero ya casi me libero.',
  'Hey! ¿Qué hay de nuevo con el tema de la reunión? Me urge saber para preparar la presentación.',
  'Qué onda! Cuéntame qué decidieron sobre lo del local, me dio mucha curiosidad.',
  'Hola, ¿sigues por ahí? Es que me aparece raro el sistema y quería confirmar contigo.',
  'Buen día! ¿Todo en orden con la entrega de hoy? Avísame si necesitas una mano.',
  'Aquí andando, gracias! Y tú qué tal? Espero que no te esté pesando mucho el trabajo.',
  'Todo bien por acá 👍. ¿Ya tienes los archivos que te pedí el lunes?',
  'Bien gracias, ¿y tú? Me dijeron que andabas de viaje pero no sabía si ya habías regresado.',
  'De maravilla! Oye, ¿ya viste lo que publicaron en el grupo de la oficina?',
  'Ahí vamos, todo tranquilo. Mañana va a estar más pesado pero hoy me la llevo relax 😌',
  'Bien bien, no me quejo 😄. Oye el fin de semana vamos a la palapa, ¿te apuntas?',
  '¿Te puedo ayudar en algo específico? Tengo un hueco libre en la tarde.',
  // Coordinación y negocios
  'Se me olvidó comentarte algo del presupuesto. No nos va a alcanzar si no ajustamos.',
  'Ya quedó lista la orden! Mañana mismo sale el envío sin falta.',
  'Te mando los detalles ahorita para que los tengas a la mano cuando llegues.',
  '¿Recibiste el PDF? Avísame si no abre bien para mandártelo de otra forma.',
  'Avísame cuando puedas, no hay prisa. Sé que andas con mil cosas hoy.',
  'Perfecto, quedamos de acuerdo 👌. Yo hablo con el proveedor para que todo fluya.',
  '¿Todo bien con el contrato? Me comentaron que querías hacerle unos cambios.',
  'Cuéntame cómo te fue en la entrevista de hoy. Estuve cruzando los dedos por ti!',
  'Qué bueno que me escribiste antes de que me fuera. Se me pasaba lo de la llave.',
  'Mejor te escribo para no interrumpirte si andas en junta.',
  // Planes personales
  '¿Ya viste las noticias de ayer? Me quedé impactado con lo que pasó, estuvo muy fuerte.',
  'Oye ¿cuándo nos vemos para comer? Tiene meses que no platicamos bien y ya hace falta.',
  '¿Tienes libre el miércoles? La tarde la tengo libre y podríamos aprovechar.',
  '¿Qué planes para el fin? Si no tienes nada podríamos ir al cine o cenar algo rico.',
  '¿Y al final qué dijo sobre la propuesta? Me dejó con la duda desde ayer.',
  'Ya te mandé lo que me pediste. Avísame cuando lo revises para hablar de los siguientes pasos.',
  'Recuerda la junta de las 3! No se te vaya a pasar como la semana pasada 😂',
  '¿Ese cliente al final firmó o no? Andaba muy raro con los pretextos.',
  // Respuestas emocionales / conversacionales
  'Ah bueno me alegra escuchar eso. Ya estaba preocupado la verdad.',
  'Jajaja no pues sí, así pasan las cosas. Al menos ya salió 😅',
  'Sí exacto, ya le iba a decir lo mismo. Menos mal que llegaste primero.',
  'Mira nada más, qué sorpresa. No me esperaba eso honestamente.',
  'Qué padre! Me da mucho gusto que haya salido bien al final 🎉',
  'Ay no pues ya qué... a lo hecho pecho y pa delante.',
  'Exacto, eso mismo pensaba yo. Mejor quedarnos con esa opción.',
  'Ahorita le digo a Carlos que te contacte para coordinar.',
  'En cuanto llegue al carro te mando los datos que me pediste.',
  '¿Y Marta ya sabe? Porque eso también le va a interesar.',
];

// ── Sistema de Bloqueo de Sesiones en Entrenamiento ──────────────────────────
// Previene que sesiones en maduración sean usadas para envío masivo
const trainingLocks = new Map(); // clientId → { lockedAt, unlocksAt, msgsCompleted, maturationHours }

function lockSession(clientId, maturationHours = 24) {
  trainingLocks.set(clientId, {
    lockedAt: Date.now(),
    unlocksAt: Date.now() + maturationHours * 60 * 60 * 1000,
    maturationHours,
    msgsCompleted: 0,
  });
  console.log(`[Lock] 🔒 ${clientId} bloqueado para bulk — maduración: ${maturationHours}h`);
}

function unlockSession(clientId) {
  trainingLocks.delete(clientId);
  console.log(`[Lock] 🔓 ${clientId} desbloqueado para envío masivo`);
}

function isSessionLocked(clientId) {
  const lock = trainingLocks.get(clientId);
  if (!lock) return null;
  if (Date.now() >= lock.unlocksAt) { unlockSession(clientId); return null; }
  return lock;
}

// ── Training state ─────────────────────────────────────────────────────────────
const trainingState = {
  running: false,
  trainingId: null,
  total: 0,
  sent: 0,
  errors: 0,
  sessions: [],  // [{ clientId, phone, name }]
  startedAt: null,
  stoppedAt: null,
  maturationHours: 24,
};



function trainingStatus() {
  const elapsed = trainingState.startedAt ? Date.now() - trainingState.startedAt : 0;
  const rate = elapsed > 0 ? trainingState.sent / (elapsed / 1000) : 0;
  const remaining = trainingState.total - trainingState.sent - trainingState.errors;
  const eta = rate > 0 ? Math.round(remaining / rate) : null;
  return {
    running: trainingState.running,
    trainingId: trainingState.trainingId,
    total: trainingState.total,
    sent: trainingState.sent,
    errors: trainingState.errors,
    sessions: trainingState.sessions.length,
    startedAt: trainingState.startedAt,
    eta,
  };
}

// POST /api/training/start
app.post('/api/training/start', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  if (trainingState.running)
    return res.status(409).json({ error: 'Ya hay un entrenamiento en curso. Deténlo primero.' });

  const {
    messagesPerNumber = null,
    minDelay = 15000,
    maxDelay = 20000,
    sessionIds = null,
    maturationHours = 24,
  } = req.body;


  const dMin = Math.max(5000, parseInt(minDelay) || 15000);
  const dMax = Math.min(60000, parseInt(maxDelay) || 20000);

  // Gather ready sessions
  let readySessions = sessionManager.getSessions().filter(s => s.status === 'ready');
  if (sessionIds && Array.isArray(sessionIds) && sessionIds.length > 0) {
    readySessions = readySessions.filter(s => sessionIds.includes(s.clientId));
  }

  if (readySessions.length < 2)
    return res.status(409).json({ error: 'Se necesitan al menos 2 sesiones conectadas para el entrenamiento.' });

  // Resolve phone numbers for each session (needed as recipient)
  const participants = readySessions.map(s => ({
    clientId: s.clientId,
    phone: s.phone,
    name: s.name || s.clientId,
  })).filter(p => p.phone); // only sessions with known phone

  if (participants.length < 2)
    return res.status(409).json({ error: 'Las sesiones no tienen número de teléfono registrado aún. Espera a que estén completamente conectadas.' });

  // Calculate total messages
  const msgsPerSession = messagesPerNumber
    ? parseInt(messagesPerNumber)
    : randomDelay(120, 180); // random default 120–180

  const total = participants.length * msgsPerSession;
  const tid = genId();
  const matur = Math.max(1, parseInt(maturationHours) || 24);

  // Bloquear sesiones participantes para envio masivo durante el entrenamiento + maduración
  participants.forEach(p => lockSession(p.clientId, matur));

  trainingState.running = true;
  trainingState.trainingId = tid;
  trainingState.total = total;
  trainingState.sent = 0;
  trainingState.errors = 0;
  trainingState.sessions = participants;
  trainingState.startedAt = Date.now();
  trainingState.stoppedAt = null;
  trainingState.maturationHours = matur;


  res.json({ success: true, trainingId: tid, total, sessions: participants.length, msgsPerSession, maturationHours: matur });

  io.emit('training:start', {
    trainingId: tid, total, sessions: participants.length, msgsPerSession,
    maturationHours: matur,
    lockedUntil: Date.now() + matur * 60 * 60 * 1000,
    sessionNames: participants.map(p => p.name),
  });


  console.log(`[Training ${tid}] ▶️  Started: ${participants.length} sessions × ${msgsPerSession} msgs = ${total} total`);

  // ── Async training loop ─────────────────────────────────────────────────────
  (async () => {
    // Build a shuffled queue: for each "round" (message index), 
    // each session sends one message to a random different session
    const queue = [];
    for (let round = 0; round < msgsPerSession; round++) {
      const shuffled = [...participants].sort(() => Math.random() - 0.5);
      for (let i = 0; i < shuffled.length; i++) {
        const sender = shuffled[i];
        // pick a random different participant as receiver
        let receiver;
        do {
          receiver = participants[Math.floor(Math.random() * participants.length)];
        } while (receiver.clientId === sender.clientId);

        const msg = TRAINING_MESSAGES[Math.floor(Math.random() * TRAINING_MESSAGES.length)];
        queue.push({ sender, receiver, message: msg });
      }
    }

    for (let i = 0; i < queue.length; i++) {
      // Check if stopped
      if (!trainingState.running) {
        console.log(`[Training ${tid}] ⏹️  Stopped at message ${i + 1}/${queue.length}`);
        break;
      }

      const { sender, receiver, message } = queue[i];
      let status = 'sent';
      let errMsg = null;

      try {
        const result = await sessionManager.sendMessage(sender.clientId, receiver.phone, message);
        trainingState.sent++;

        // --- Mejora Anti-Bloqueo: Simular lectura (Read Receipt) ---
        // La cuenta que recibe el mensaje espera un poco y lo marca como leído
        if (result && result.messageId) {
          setTimeout(async () => {
            try {
              await sessionManager.readMessages(receiver.clientId, `${sender.phone}@s.whatsapp.net`, [result.messageId]);
              console.log(`[Training] 👀 ${receiver.name} marcó como leído mensaje de ${sender.name}`);
            } catch (e) { }
          }, randomDelay(2000, 5000)); // Lee entre 2 y 5 segundos después
        }

      } catch (err) {
        status = 'error';
        errMsg = friendlyError(err.message);
        trainingState.errors++;
        console.warn(`[Training ${tid}] ❌ ${sender.name} → ${receiver.name}: ${err.message}`);
      }

      io.emit('training:progress', {
        trainingId: tid,
        index: i + 1,
        total: queue.length,
        from: sender.name,
        to: receiver.name,
        message,
        status,
        error: errMsg,
        sent: trainingState.sent,
        errors: trainingState.errors,
      });

      if (i < queue.length - 1 && trainingState.running) {
        const waitMs = randomDelay(dMin, dMax);
        io.emit('training:waiting', {
          trainingId: tid,
          index: i + 1, total: queue.length,
          waitMs,
          nextFrom: queue[i + 1].sender.name,
          nextTo: queue[i + 1].receiver.name,
        });
        await sleep(waitMs);
      }
    }

    trainingState.running = false;
    trainingState.stoppedAt = Date.now();
    const duration = Math.round((trainingState.stoppedAt - trainingState.startedAt) / 1000);
    const maturMs = (trainingState.maturationHours || 24) * 60 * 60 * 1000;

    // Reiniciar reloj de maduración desde ahora (fin del entrenamiento)
    participants.forEach(p => {
      const lk = trainingLocks.get(p.clientId);
      if (lk) lk.unlocksAt = Date.now() + maturMs;
    });

    io.emit('training:complete', {
      trainingId: tid,
      total: trainingState.total,
      sent: trainingState.sent,
      errors: trainingState.errors,
      duration,
      lockedUntil: Date.now() + maturMs,
    });

    console.log(`[Training ${tid}] Completado: ${trainingState.sent} enviados, ${trainingState.errors} errores, ${duration}s. Maduración: ${trainingState.maturationHours}h`);
  })();
});

// GET /api/training/locks — bloqueos activos de maduración
app.get('/api/training/locks', auth.requireAuth, auth.requireAdmin, (_req, res) => {
  const locks = [];
  trainingLocks.forEach((lock, clientId) => {
    if (Date.now() >= lock.unlocksAt) { unlockSession(clientId); return; }
    locks.push({
      clientId,
      lockedAt: lock.lockedAt,
      unlocksAt: lock.unlocksAt,
      maturationHours: lock.maturationHours,
      msgsCompleted: lock.msgsCompleted,
      remainingMin: Math.ceil((lock.unlocksAt - Date.now()) / 60000),
    });
  });
  res.json({ locks });
});

// DELETE /api/training/locks/:clientId — desbloqueo manual (solo superadmin)
app.delete('/api/training/locks/:clientId', auth.requireAuth, (req, res) => {
  if (req.user.role !== 'superadmin')
    return res.status(403).json({ error: 'Solo Superadmin puede desbloquear manualmente' });
  const { clientId } = req.params;
  if (!trainingLocks.has(clientId))
    return res.status(404).json({ error: `${clientId} no está bloqueado` });
  unlockSession(clientId);
  io.emit('training:unlocked', { clientId });
  res.json({ success: true, message: `${clientId} desbloqueado manualmente` });
});


// ── Proxy Pool API ──
app.get('/api/proxies/pool', auth.requireAuth, prohibitAsesor, (req, res) => {
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Solo Superadmin' });
  if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });
  const stats = dbModule.stmts.getProxyStats();
  const list = dbModule.stmts.getProxies();
  res.json({ stats, list });
});

app.post('/api/proxies/pool/bulk', auth.requireAuth, prohibitAsesor, (req, res) => {
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Solo Superadmin' });
  const { rawText } = req.body;
  if (!rawText) return res.status(400).json({ error: 'Falta rawText' });

  const proxies = rawText.split('\n').map(line => line.trim()).filter(Boolean);
  const normalized = proxies.map(p => {
    if (p.includes('://')) return p;
    const parts = p.split(':');
    if (parts.length === 4) return `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
    if (parts.length === 2) return `http://${parts[0]}:${parts[1]}`;
    return p;
  });

  if (dbReady) dbModule.stmts.addProxiesToPool(normalized);
  res.json({ success: true, count: normalized.length });
});

app.delete('/api/proxies/pool', auth.requireAuth, prohibitAsesor, (req, res) => {
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Solo Superadmin' });
  if (dbReady) dbModule.stmts.clearProxyPool();
  res.json({ success: true });
});

// POST /api/training/stop
app.post('/api/training/stop', auth.requireAuth, auth.requireAdmin, (req, res) => {
  if (!trainingState.running)
    return res.status(409).json({ error: 'No hay entrenamiento en curso.' });
  trainingState.running = false;
  res.json({ success: true, message: 'Entrenamiento detenido. El mensaje actual terminará antes de parar.' });
});

// GET /api/training/status
app.get('/api/training/status', auth.requireAuth, auth.requireAdmin, (_req, res) => {
  res.json(trainingStatus());
});

// ═══════════════════════════════════════════════════════════════════════════════
// Socket.IO
// ═══════════════════════════════════════════════════════════════════════════════
io.on('connection', socket => {
  socket.emit('sessions:list', { sessions: sessionManager.getSessions() });
  socket.emit('reports:init', { reports: liveReports.slice(0, 500) });
  socket.emit('db:status', { ready: dbReady });

  for (const [clientId, data] of sessionManager.sessions) {
    if (data.status === 'qr_pending' && data.qr)
      socket.emit('session:qr', { clientId, qr: data.qr, label: data.name });
  }
});

// ── Catch-all ─────────────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// ── Start ──────────────────────────────────────────────────────────────────────
(async () => {
  await initDb();

  httpServer.listen(PORT, () => {
    console.log(`\n🚀 WhatsApp Sender v3 → http://localhost:${PORT}\n`);
  });

  if (dbReady) {
    const saved = dbModule.stmts.getAllSessions();
    if (saved.length > 0) {
      console.log(`🔄 Restaurando ${saved.length} sesión(es) guardada(s)...`);
      for (const s of saved) {
        try {
          const session = await sessionManager.createSession(s.client_id, s.label);
          // Restaurar configuración avanzada (Temporalmente deshabilitado)
          /*
          session.proxy = s.proxy;
          session.ai_enabled = s.ai_enabled === 1;
          session.ai_prompt = s.ai_prompt;
          */

          console.log(`  ✓ Restaurando sesión "${s.client_id}"`);
          await sleep(1500);
        } catch (err) {
          console.error(`  ✖ No se pudo restaurar "${s.client_id}":`, err.message);
        }
      }
    }
  }
})();

// ═══════════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function normalizeMx10(raw) {
  let n = String(raw).replace(/\D/g, '');
  if (n.length === 13 && n.startsWith('521')) n = n.slice(3);
  else if (n.length === 12 && n.startsWith('52')) n = n.slice(2);
  else if (n.length === 11 && n.startsWith('1')) n = n.slice(1);
  return n.length === 10 ? n : null;
}

function applyTemplate(template, row) {
  return template.replace(/\{\{(\w+)\}\}/gi, (_, key) => {
    const val = row[key.toLowerCase()];
    return val !== undefined && val !== '' ? val : '';
  });
}

function makeEntry(batchId, row, mensaje, sessionUsed, status, error) {
  return {
    id: genId(), batchId,
    numero: row.numero, cuenta: row.cuenta || '',
    mensaje, sessionUsed, status,
    error: error || null, messageId: null,
    timestamp: new Date().toISOString()
  };
}

function persistAndEmit(entry, batchId) {
  if (dbReady) {
    try {
      dbModule.stmts.insertMessage({
        id: entry.id, batch_id: batchId,
        numero: entry.numero, cuenta: entry.cuenta,
        mensaje_final: entry.mensaje,
        session_used: entry.sessionUsed,
        status: entry.status, timestamp: entry.timestamp
      });
      if (entry.error) {
        dbModule.stmts.updateMessage({
          id: entry.id, status: entry.status,
          error: entry.error, message_id: null, timestamp: entry.timestamp
        });
      }
    } catch (e) { /* non-fatal */ }
  }
  addReport(entry);
}

function friendlyError(msg = '') {
  if (msg.includes('No LID')) return 'Número no encontrado en WhatsApp (sin LID)';
  if (msg.includes('not registered')) return 'Número no registrado en WhatsApp';
  if (msg.includes('not ready')) return 'Sesión no lista — reconecta el número';
  if (msg.includes('invalid')) return 'Número inválido o mal formateado';
  if (msg.includes('rate')) return 'Límite de velocidad alcanzado (rate limit)';
  if (msg.includes('timeout')) return 'Timeout al enviar — verifica la conexión';
  if (msg.includes('not found')) return 'Sesión no encontrada';
  if (msg.includes('Protocol error')) return 'Error de protocolo — reinicia la sesión';
  if (msg.includes('no está registrado')) return msg;
  if (msg.includes('dígitos')) return msg;
  return msg;
}

function csvVal(v) {
  const s = String(v || '').replace(/"/g, '""');
  return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s}"` : s;
}

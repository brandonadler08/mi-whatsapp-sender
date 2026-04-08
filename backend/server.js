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
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST', 'DELETE'] }
});

const PORT = process.env.PORT || 3000;
const sessionManager = new SessionManager();

// ── In-memory live reports ────────────────────────────────────────────────────
const liveReports = [];
let rrIndex = 0;

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
sessionManager.on('ready', d => io.emit('session:ready', d));
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

  try {
    const result = await sessionManager.sendMessage(clientId, to, message);
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
  const { rows, clientId, minDelay, maxDelay, template, batchName, warmup } = req.body;
  const { user } = req;

  if (!rows || !Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ error: 'rows requerido' });
  if (!clientId)
    return res.status(400).json({ error: 'clientId requerido' });
  if (!template?.trim())
    return res.status(400).json({ error: 'La plantilla del mensaje es requerida' });

  const useRotation = clientId === 'ALL';
  const dMin = Math.max(500, parseInt(minDelay) || 1000);
  const dMax = Math.min(60000, parseInt(maxDelay) || 15000);
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

  if (dbReady) {
    dbModule.stmts.insertBatch({
      id: batchId, name, total: rows.length,
      session_mode: useRotation ? 'ALL' : clientId,
      delay_ms: dMin, template,
      owner_id: user.id,
      created_at: batchCreated
    });
  }

  res.json({ success: true, batchId, total: rows.length });

  // ── Async bulk send ───────────────────────────────────────────────────────
  (async () => {
    activeBatches.set(batchId, {
      name: name,
      total: rows.length,
      done: 0,
      sent: 0,
      errors: 0
    });

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const { numero, cuenta } = row;
      const mensajeFinal = applySpintax(applyTemplate(template, row));

      let session;
      if (useRotation) {
        session = getNextReadySession(user.role !== 'superadmin' ? user.id : null);
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
            batchId, sessionClientId: session.clientId, mensajeFinal, entry, timerId: tId
          });
        } else {
          // Si apagó "warmup", enviamos el mensaje principal directamente
          const tId = setTimeout(() => executePayload(numero, false), 500);
          pendingPayloads.set(numero, {
            batchId, sessionClientId: session.clientId, mensajeFinal, entry, timerId: tId
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

      if (i < rows.length - 1) {
        const waitMs = randomDelay(dMin, dMax);
        io.emit('bulk:waiting', { batchId, index: i + 1, total: rows.length, waitMs });
        await sleep(waitMs);
      }
    }

    // Todos los saludos enviados, o procesados hasta fase pendiente.
    io.emit('bulk:greetings_done', { batchId, batchName: name, total: rows.length });

  })();
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
  'Hola! 👋 ¿Cómo vas con el proyecto? Me quedé pensando en lo que platicamos ayer sobre los nuevos planes.',
  'Buenos días! Espero que todo esté bien por allá. ¿A qué hora crees que podamos revisar los detalles pendientes?',
  'Buenas tardes 😊. Oye, te mandé un correo hace rato con la propuesta actualizada, ¿lo pudiste checar o andas muy ocupado?',
  'Hola qué tal, ¿cómo va tu semana? Yo aquí terminando unas cosas pero ya casi me libero para lo que necesites.',
  'Hey! ¿Qué hay de nuevo con el tema de la reunión? Me urge saber para ir preparando la presentación.',
  'Qué onda! Cuéntame qué decidieron al final sobre lo del local, me dio mucha curiosidad saber en qué quedó todo.',
  'Hola, ¿sigues por ahí? Es que me aparece que no le llegan los mensajes a Juan y quería confirmar contigo.',
  'Buen día! ¿Todo en orden con la entrega de hoy? Avísame si necesitas una mano con algo antes de cerrar.',
  'Aquí andando, gracias! Y tú qué tal? Espero que no te esté pesando mucho el trabajo estos días.',
  'Todo bien por acá 👍. Justo te iba a preguntar si ya tienes los archivos que te pedí el lunes, para avanzar.',
  'Bien gracias, ¿y tú qué cuentas de nuevo? Me dijeron que andabas de viaje pero no sabía si ya habías regresado.',
  'De maravilla, gracias por preguntar! Oye, por cierto, ¿ya viste lo que publicaron en el grupo de la oficina?',
  'Ahí vamos, todo tranquilo por el momento. Mañana va a estar más pesado pero hoy me la llevo relax.',
  'Excelente! Gracias. ¿Tú cómo estás? Me imagite que tenías mucha chamba por lo de la auditoría.',
  'Bien bien, no me quejo 😄. Oye, el fin de semana vamos a ir a la palapa, ¿te apuntas o ya tienes planes?',
  'Todo bien gracias! ¿Te puedo ayudar en algo específico? Tengo un hueco libre en la tarde por si quieres hablar.',
  '¿Ya viste lo de ayer en las noticias? Me quedé impactado con lo que pasó en el centro, estuvo muy fuerte.',
  'Oye, ¿cuándo nos vemos para comer? Tiene meses que no platicamos bien y ya hace falta el chismecito.',
  'La próxima semana está bien para ti? El miércoles tengo la tarde libre y podríamos aprovechar para vernos.',
  '¿Qué planes tienes para el fin de semana? Si no tienes nada que hacer, podríamos ir al cine o a cenar algo.',
  'Por cierto, se me olvidó comentarte algo importante sobre el presupuesto. No nos va a alcanzar si no ajustamos.',
  'Justo iba a escribirte para decirte que ya quedó lista la orden. Mañana mismo sale el envío sin falta.',
  'Te mando los detalles ahora mismo por aquí para que los tengas a la mano en cuanto llegues a la oficina.',
  '¿Recibiste lo que te mandé por PDF? Avísame si no abre bien para volvértelo a mandar por otro medio.',
  'Avísame cuando puedas, no hay prisa realmente. Sé que andas con mil cosas en la cabeza hoy.',
  'Perfecto, quedamos de acuerdo entonces 👌. Yo me encargo de hablar con el proveedor para que todo fluya.',
  '¿Todo bien con lo que te envié del contrato? Me comentaron que querías hacerle unos cambios pequeños.',
  'Cuéntame cómo te fue en la entrevista de hoy. Estuve cruzando los dedos por ti todo el tiempo!',
  'Qué bueno que me escribiste antes de que me fuera. Se me estaba pasando decirte lo de la llave.',
  'Justo te iba a marcar por teléfono, pero mejor te escribo por aquí para no interrumpirte si andas en junta.',
];

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
    messagesPerNumber = null,  // si null → random 120–180 por sesión
    minDelay = 15000,
    maxDelay = 20000,
    sessionIds = null,  // null = todas las ready
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

  // Update state
  trainingState.running = true;
  trainingState.trainingId = tid;
  trainingState.total = total;
  trainingState.sent = 0;
  trainingState.errors = 0;
  trainingState.sessions = participants;
  trainingState.startedAt = Date.now();
  trainingState.stoppedAt = null;

  res.json({ success: true, trainingId: tid, total, sessions: participants.length, msgsPerSession });

  io.emit('training:start', {
    trainingId: tid, total, sessions: participants.length, msgsPerSession,
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

    io.emit('training:complete', {
      trainingId: tid,
      total: trainingState.total,
      sent: trainingState.sent,
      errors: trainingState.errors,
      duration,
    });

    console.log(`[Training ${tid}] ✅ Completed: ${trainingState.sent} sent, ${trainingState.errors} errors, ${duration}s`);
  })();
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

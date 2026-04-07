// ── Load env vars first ───────────────────────────────────────────────────────
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// ── PROTECCIÓN GLOBAL CONTRA CAÍDAS ──────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('\n[CRITICAL ERROR] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('\n[CRITICAL ERROR] Unhandled Rejection at:', promise, 'reason:', reason);
});

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const path       = require('path');
const multer     = require('multer');
const XLSX       = require('xlsx');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');

const auth = require('./auth');

// ── Database ───────────────────────────────────────────────────────────────────
let dbReady  = false;
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

const app        = express();
const httpServer = http.createServer(app);
const io         = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST', 'DELETE'] }
});

const PORT           = process.env.PORT || 3000;
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
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ── Rate limiting en login (anti-brute-force) ──────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,                               // 15 minutos
  max:      parseInt(process.env.LOGIN_RATE_LIMIT) || 20, // máx intentos
  message:  { error: 'Demasiados intentos. Intenta en 15 minutos.' },
  standardHeaders: true,
  legacyHeaders:   false,
});

// ── Session Manager → Socket.IO ───────────────────────────────────────────────
sessionManager.on('qr',             d => io.emit('session:qr', d));
sessionManager.on('authenticated',  d => io.emit('session:authenticated', d));
sessionManager.on('ready',          d => io.emit('session:ready', d));
sessionManager.on('disconnected',   d => io.emit('session:disconnected', d));
sessionManager.on('auth_failure',   d => io.emit('session:auth_failure', d));
sessionManager.on('session_removed',d => io.emit('session:removed', d));

// ── Lógica Asíncrona Masiva (Bandeja Inteligente) ────────────────────────────
const pendingPayloads = new Map();
const activeBatches   = new Map();

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
    if (isReply) {
      // Simular latencia humana al responder (2 - 4.5 segundos)
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 2500));
    }
    await sessionManager.sendMessage(sessionClientId, numero, mensajeFinal);
    entry.status = 'sent';
    entry.timestamp = new Date().toISOString();
    batch.sent++;
  } catch(err) {
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
  if (dbReady) {
    dbModule.stmts.insertReply({
      id: replyData.id,
      session_id: replyData.clientId,
      from_number: replyData.from_number,
      author_name: replyData.author_name,
      message_text: replyData.message_text,
      timestamp: replyData.timestamp
    });
  }
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
  if (!ok)  return res.status(401).json({ error: 'Credenciales incorrectas' });

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

app.get('/api/users', auth.requireAuth, auth.requireAdmin, (_req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });
  res.json({ users: dbModule.stmts.listUsers() });
});

app.post('/api/users', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  const { username, password, role } = req.body;
  if (!username?.trim() || !password)
    return res.status(400).json({ error: 'username y password son requeridos' });
  if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });

  const existing = dbModule.stmts.getUserByUsername(username.trim());
  if (existing) return res.status(409).json({ error: `Usuario "${username}" ya existe` });

  const hashed = await auth.hashPassword(password);
  const id = dbModule.stmts.createUser({
    username: username.trim(),
    password: hashed,
    role: role === 'superadmin' ? 'superadmin' : 'user'
  });
  res.json({ success: true, id });
});

app.delete('/api/users/:id', auth.requireAuth, auth.requireAdmin, (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });
  // Prevent deleting yourself
  if (req.params.id === req.user.id)
    return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });

  const user = dbModule.stmts.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (user.role === 'superadmin')
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
  const ok   = await auth.verifyPassword(currentPassword, user.password);
  if (!ok) return res.status(401).json({ error: 'Contraseña actual incorrecta' });

  const hashed = await auth.hashPassword(newPassword);
  dbModule.stmts.updatePassword(req.user.id, hashed);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REST API — Sessions  [PROTECTED]
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/sessions', auth.requireAuth, (_req, res) => {
  const { user } = _req;
  let sessions = sessionManager.getSessions();

  if (user.role !== 'superadmin' && dbReady) {
    const owned = dbModule.stmts.getSessionsByOwner(user.id).map(r => r.client_id);
    sessions = sessions.filter(s => owned.includes(s.clientId));
  }

  res.json({ sessions });
});

app.post('/api/sessions', auth.requireAuth, async (req, res) => {
  const { clientId, label } = req.body;
  if (!clientId?.trim()) return res.status(400).json({ error: 'clientId es requerido' });

  const id = clientId.trim().replace(/[^a-zA-Z0-9_-]/g, '-');
  if (sessionManager.hasSession(id))
    return res.status(409).json({ error: `La sesión "${id}" ya existe` });

  if (dbReady) {
    dbModule.stmts.insertSession({
      clientId: id,
      label:    label || id,
      owner_id: req.user.id,
      created_at: new Date().toISOString()
    });
  }

  sessionManager.createSession(id, label || id).catch(err => {
    io.emit('session:error', { clientId: id, error: err.message });
  });

  res.json({ success: true, clientId: id });
});

app.delete('/api/sessions/:id', auth.requireAuth, async (req, res) => {
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
    if (dbReady) dbModule.stmts.deleteSession(sid);
    res.json({ success: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ── Single send ───────────────────────────────────────────────────────────────
app.post('/api/send', auth.requireAuth, async (req, res) => {
  const { clientId, to, message } = req.body;
  if (!clientId || !to || !message)
    return res.status(400).json({ error: 'clientId, to y message son requeridos' });

  // Ownership check
  if (req.user.role !== 'superadmin' && dbReady) {
    const ownerId = dbModule.stmts.getSessionOwner(clientId);
    if (ownerId !== req.user.id)
      return res.status(403).json({ error: 'No tienes permiso para usar esta sesión' });
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
  const ownerId = user.role !== 'superadmin' ? user.id : null;
  const replies = dbModule.stmts.getReplies(ownerId, 1000);
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

app.post('/api/parse-xlsx', auth.requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });

  try {
    const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const raw  = XLSX.utils.sheet_to_json(ws, { defval: '' });

    if (raw.length === 0) return res.status(422).json({ error: 'El archivo está vacío' });

    const allKeys      = Object.keys(raw[0]).map(k => k.toLowerCase().trim());
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
app.post('/api/send-bulk-xlsx', auth.requireAuth, async (req, res) => {
  const { rows, clientId, minDelay, maxDelay, template, batchName, warmup } = req.body;
  const { user } = req;

  if (!rows || !Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ error: 'rows requerido' });
  if (!clientId)
    return res.status(400).json({ error: 'clientId requerido' });
  if (!template?.trim())
    return res.status(400).json({ error: 'La plantilla del mensaje es requerida' });

  const useRotation = clientId === 'ALL';
  const dMin        = Math.max(500,   parseInt(minDelay) || 1000);
  const dMax        = Math.min(60000, parseInt(maxDelay) || 15000);
  const batchId      = genId();
  const batchCreated = new Date().toISOString();
  const name         = batchName?.trim() || `Envío ${new Date().toLocaleString('es-MX')}`;

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
      const mensajeFinal = applyTemplate(template, row);

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
        entry.status    = 'error';
        entry.error     = friendlyError(err.message);
        entry.timestamp = new Date().toISOString();
        
        if (dbReady) dbModule.stmts.updateMessage({
          id: entry.id, status: entry.status,
          error: entry.error, message_id: null,
          timestamp: entry.timestamp
        });
        addReport(entry);
        
        const batch = activeBatches.get(batchId);
        if(batch) {
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
app.get('/api/reports', auth.requireAuth, (req, res) => {
  const { batchId, status, limit = 500 } = req.query;
  const { user } = req;
  let result = liveReports;
  if (batchId) result = result.filter(r => r.batchId === batchId);
  if (status)  result = result.filter(r => r.status  === status);
  res.json({ total: result.length, reports: result.slice(0, parseInt(limit)) });
});

app.delete('/api/reports', auth.requireAuth, (_req, res) => {
  liveReports.length = 0;
  io.emit('report:cleared');
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REST API — History (SQLite)  [PROTECTED]
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/history', auth.requireAuth, (req, res) => {
  if (!dbReady) return res.json({ dbReady: false, batches: [] });
  const { user } = req;
  const limit   = Math.min(parseInt(req.query.limit) || 100, 500);
  const ownerId = user.role === 'superadmin' ? null : user.id;
  const batches = dbModule.stmts.getBatches(limit, ownerId);
  res.json({ dbReady: true, batches });
});

app.get('/api/history/stats', auth.requireAuth, (req, res) => {
  if (!dbReady) return res.json({ dbReady: false });
  const { user } = req;
  const ownerId = user.role === 'superadmin' ? null : user.id;
  const stats = dbModule.stmts.getTotalStats(ownerId);
  res.json({ dbReady: true, ...stats });
});

app.get('/api/history/:batchId', auth.requireAuth, (req, res) => {
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

app.delete('/api/history/:batchId', auth.requireAuth, (req, res) => {
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

app.get('/api/history/:batchId/csv', auth.requireAuth, (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });
  const { user } = req;
  const ownerId = user.role === 'superadmin' ? null : user.id;

  const batch = dbModule.stmts.getBatch(req.params.batchId, ownerId);
  if (!batch) return res.status(404).json({ error: 'Lote no encontrado o sin acceso' });

  const messages = dbModule.stmts.getMessages(req.params.batchId);
  const headers  = ['#','Numero','Cuenta','Mensaje','Sesion','Estado','Error','Hora'];
  const lines    = ['\uFEFF' + headers.join(',')];

  messages.forEach((m, i) => {
    lines.push([
      i + 1, csvVal(m.numero), csvVal(m.cuenta), csvVal(m.mensaje_final),
      csvVal(m.session_used), m.status, csvVal(m.error || ''),
      csvVal(m.timestamp ? new Date(m.timestamp).toLocaleString('es-MX') : '')
    ].join(','));
  });

  const filename = `batch_${batch.id}_${batch.name.replace(/[^a-z0-9]/gi,'_').slice(0,30)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(lines.join('\n'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// TRAINING MODE  [PROTECTED — superadmin only]
// ═══════════════════════════════════════════════════════════════════════════════

// ── Banco de mensajes naturales para simular conversación ─────────────────────
const TRAINING_MESSAGES = [
  // Saludos / apertura
  'Hola! 👋 ¿Cómo estás?',
  'Buenos días! Todo bien por allá?',
  'Buenas tardes 😊',
  'Hola qué tal, cómo va todo?',
  'Hey! ¿Qué hay de nuevo?',
  'Qué onda! Cuéntame',
  'Hola, ¿sigues por ahí?',
  'Buen día! ¿Todo en orden?',

  // Respuestas de saludo
  'Aquí andando, gracias! Y tú?',
  'Todo bien por acá 👍',
  'Bien gracias, ¿y tú qué cuentas?',
  'De maravilla, gracias por preguntar!',
  'Ahí vamos, todo tranquilo',
  'Excelente! Gracias. ¿Tú cómo estás?',
  'Bien bien, no me quejo 😄',
  'Todo bien gracias! ¿Te puedo ayudar en algo?',

  // Conversación casual
  '¿Ya viste lo de ayer?',
  'Oye, ¿cuándo nos vemos?',
  'La próxima semana está bien para ti?',
  '¿Qué planes tienes para el fin de semana?',
  'Por cierto, se me olvidó comentarte algo',
  'Justo iba a escribirte',
  'Te mando los detalles ahora',
  '¿Recibiste lo que te mandé?',
  'Avísame cuando puedas, no hay prisa',
  'Perfecto, quedamos de acuerdo entonces 👌',
  '¿Todo bien con lo que te envié?',
  'Cuéntame cómo te fue',
  'Qué bueno que me escribiste',
  'Justo te iba a marcar',

  // Confirmaciones / acuerdos
  'Perfecto, gracias 🙌',
  'Entendido, te aviso',
  'Claro que sí, sin problema',
  'Ok, de acuerdo!',
  'Listo, ya quedó',
  'Perfecto, ahí estaré',
  'Confirmado ✅',
  'Va, te llamo después',

  // Preguntas breves
  '¿Me puedes llamar más tarde?',
  '¿A qué hora quedamos?',
  '¿Dónde nos vemos?',
  '¿Ya terminaste?',
  '¿Necesitas algo más?',
  '¿Cómo quedó al final?',
  '¿Cuánto tiempo tienes?',

  // Mensajes informativos
  'Acabo de llegar',
  'Ya voy para allá',
  'Estoy en camino 🚗',
  'Tardare como 10 minutos',
  'Ya llegué!',
  'Espérame, ya casi',
  'Voy saliendo ahorita',

  // Cierre
  'Hablamos luego 👋',
  'Cuídate mucho!',
  'Saludos a todos!',
  'Hasta luego 😊',
  'Gracias, que tengas buen día!',
  'Ok, cualquier cosa me dices',
  'Listo, nos hablamos',
  'Buenas noches! 🌙',
];

// ── Training state ─────────────────────────────────────────────────────────────
const trainingState = {
  running:    false,
  trainingId: null,
  total:      0,
  sent:       0,
  errors:     0,
  sessions:   [],  // [{ clientId, phone, name }]
  startedAt:  null,
  stoppedAt:  null,
};

function trainingStatus() {
  const elapsed = trainingState.startedAt ? Date.now() - trainingState.startedAt : 0;
  const rate    = elapsed > 0 ? trainingState.sent / (elapsed / 1000) : 0;
  const remaining = trainingState.total - trainingState.sent - trainingState.errors;
  const eta     = rate > 0 ? Math.round(remaining / rate) : null;
  return {
    running:    trainingState.running,
    trainingId: trainingState.trainingId,
    total:      trainingState.total,
    sent:       trainingState.sent,
    errors:     trainingState.errors,
    sessions:   trainingState.sessions.length,
    startedAt:  trainingState.startedAt,
    eta,
  };
}

// POST /api/training/start
app.post('/api/training/start', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  if (trainingState.running)
    return res.status(409).json({ error: 'Ya hay un entrenamiento en curso. Deténlo primero.' });

  const {
    messagesPerNumber = null,  // si null → random 120–180 por sesión
    minDelay          = 15000,
    maxDelay          = 20000,
    sessionIds        = null,  // null = todas las ready
  } = req.body;

  const dMin = Math.max(5000,  parseInt(minDelay)  || 15000);
  const dMax = Math.min(60000, parseInt(maxDelay)  || 20000);

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
    phone:    s.phone,
    name:     s.name || s.clientId,
  })).filter(p => p.phone); // only sessions with known phone

  if (participants.length < 2)
    return res.status(409).json({ error: 'Las sesiones no tienen número de teléfono registrado aún. Espera a que estén completamente conectadas.' });

  // Calculate total messages
  const msgsPerSession = messagesPerNumber
    ? parseInt(messagesPerNumber)
    : randomDelay(120, 180); // random default 120–180

  const total = participants.length * msgsPerSession;
  const tid   = genId();

  // Update state
  trainingState.running    = true;
  trainingState.trainingId = tid;
  trainingState.total      = total;
  trainingState.sent       = 0;
  trainingState.errors     = 0;
  trainingState.sessions   = participants;
  trainingState.startedAt  = Date.now();
  trainingState.stoppedAt  = null;

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
        const sender   = shuffled[i];
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
        await sessionManager.sendMessage(sender.clientId, receiver.phone, message);
        trainingState.sent++;
      } catch (err) {
        status = 'error';
        errMsg = friendlyError(err.message);
        trainingState.errors++;
        console.warn(`[Training ${tid}] ❌ ${sender.name} → ${receiver.name}: ${err.message}`);
      }

      io.emit('training:progress', {
        trainingId: tid,
        index:      i + 1,
        total:      queue.length,
        from:       sender.name,
        to:         receiver.name,
        message,
        status,
        error:      errMsg,
        sent:       trainingState.sent,
        errors:     trainingState.errors,
      });

      if (i < queue.length - 1 && trainingState.running) {
        const waitMs = randomDelay(dMin, dMax);
        io.emit('training:waiting', {
          trainingId: tid,
          index: i + 1, total: queue.length,
          waitMs,
          nextFrom: queue[i + 1].sender.name,
          nextTo:   queue[i + 1].receiver.name,
        });
        await sleep(waitMs);
      }
    }

    trainingState.running   = false;
    trainingState.stoppedAt = Date.now();
    const duration = Math.round((trainingState.stoppedAt - trainingState.startedAt) / 1000);

    io.emit('training:complete', {
      trainingId: tid,
      total:  trainingState.total,
      sent:   trainingState.sent,
      errors: trainingState.errors,
      duration,
    });

    console.log(`[Training ${tid}] ✅ Completed: ${trainingState.sent} sent, ${trainingState.errors} errors, ${duration}s`);
  })();
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
  socket.emit('reports:init',  { reports: liveReports.slice(0, 500) });
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
          await sessionManager.createSession(s.client_id, s.label);
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
  else if (n.length === 12 && n.startsWith('52'))  n = n.slice(2);
  else if (n.length === 11 && n.startsWith('1'))   n = n.slice(1);
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
  if (msg.includes('No LID'))             return 'Número no encontrado en WhatsApp (sin LID)';
  if (msg.includes('not registered'))     return 'Número no registrado en WhatsApp';
  if (msg.includes('not ready'))          return 'Sesión no lista — reconecta el número';
  if (msg.includes('invalid'))            return 'Número inválido o mal formateado';
  if (msg.includes('rate'))               return 'Límite de velocidad alcanzado (rate limit)';
  if (msg.includes('timeout'))            return 'Timeout al enviar — verifica la conexión';
  if (msg.includes('not found'))          return 'Sesión no encontrada';
  if (msg.includes('Protocol error'))     return 'Error de protocolo — reinicia la sesión';
  if (msg.includes('no está registrado')) return msg;
  if (msg.includes('dígitos'))            return msg;
  return msg;
}

function csvVal(v) {
  const s = String(v || '').replace(/"/g, '""');
  return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s}"` : s;
}

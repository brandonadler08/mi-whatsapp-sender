/**
 * database.js — SQLite persistence via sql.js (WebAssembly, no native compilation)
 * Data is saved to ./data/whatsapp_sender.db as a binary SQLite file.
 */
const path = require('path');
const fs   = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH  = path.join(DATA_DIR, 'whatsapp_sender.db');
const SAVE_DEBOUNCE_MS = 2000; // write to disk at most every 2s

let db       = null;
let SQL      = null;
let saveTimer = null;

/** Initialize sql.js and load/create the DB file */
async function init() {
  const initSqlJs = require('sql.js');
  SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
    console.log(`✅ SQLite DB loaded from ${DB_PATH}`);
  } else {
    db = new SQL.Database();
    console.log(`✅ SQLite DB created at ${DB_PATH}`);
  }

  // Schema
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      username   TEXT UNIQUE NOT NULL,
      password   TEXT NOT NULL,
      role       TEXT DEFAULT 'admin',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      client_id  TEXT PRIMARY KEY,
      label      TEXT,
      owner_id   TEXT,
      proxy      TEXT,
      ai_enabled INTEGER DEFAULT 0,
      ai_prompt  TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS batches (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      total        INTEGER DEFAULT 0,
      sent         INTEGER DEFAULT 0,
      errors       INTEGER DEFAULT 0,
      session_mode TEXT,
      delay_ms     INTEGER DEFAULT 2000,
      template     TEXT,
      owner_id     TEXT,
      created_at   TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id            TEXT PRIMARY KEY,
      batch_id      TEXT NOT NULL,
      numero        TEXT NOT NULL,
      cuenta        TEXT,
      mensaje_final TEXT,
      session_used  TEXT,
      status        TEXT DEFAULT 'pending',
      error         TEXT,
      message_id    TEXT,
      timestamp     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_msg_batch  ON messages(batch_id);
    CREATE INDEX IF NOT EXISTS idx_msg_status ON messages(status);
    CREATE INDEX IF NOT EXISTS idx_batch_date ON batches(created_at);

    CREATE TABLE IF NOT EXISTS replies (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      from_number   TEXT NOT NULL,
      author_name   TEXT,
      message_text  TEXT,
      timestamp     TEXT NOT NULL,
      is_read       INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_replies_session ON replies(session_id);
    CREATE INDEX IF NOT EXISTS idx_replies_read    ON replies(is_read);

    CREATE TABLE IF NOT EXISTS proxy_pool (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      url        TEXT UNIQUE NOT NULL,
      is_used    INTEGER DEFAULT 0,
      session_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_proxy_used ON proxy_pool(is_used);
  `);

  // ── Migrations: add columns if they don't exist (for existing DBs) ──────────
  const migrations = [
    `ALTER TABLE sessions ADD COLUMN owner_id TEXT`,
    `ALTER TABLE batches  ADD COLUMN owner_id TEXT`,
    `ALTER TABLE users    ADD COLUMN parent_id TEXT`,
    `ALTER TABLE replies  ADD COLUMN asesor_id TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_sess_owner  ON sessions(owner_id)`,
    `CREATE INDEX IF NOT EXISTS idx_batch_owner ON batches(owner_id)`,
    `CREATE INDEX IF NOT EXISTS idx_user_parent ON users(parent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_replies_asesor ON replies(asesor_id)`,
    `ALTER TABLE sessions ADD COLUMN proxy TEXT`,
    `ALTER TABLE sessions ADD COLUMN ai_enabled INTEGER DEFAULT 0`,
    `ALTER TABLE sessions ADD COLUMN ai_prompt TEXT`,
    // Perfil de historial: NULL = sin definir, 0 = número nuevo, 1 = tiene historial
    `ALTER TABLE sessions ADD COLUMN has_history INTEGER DEFAULT NULL`,
    // Nivel de envío: 0 = necesita entrenamiento, 1 = nivel 1 (30-50/día), 2 = nivel 2 (80-100/día), 3 = nivel 3 (150+/día)
    `ALTER TABLE sessions ADD COLUMN history_level INTEGER DEFAULT 0`,
    // Fecha en que se marcó el historial
    `ALTER TABLE sessions ADD COLUMN history_set_at TEXT DEFAULT NULL`
  ];
  for (const sql of migrations) {
    try { db.run(sql); } catch (_) { /* column already exists — skip */ }
  }

  saveToDisk(); // initial save
  return db;
}

/** Persist DB to disk (debounced) */
function saveToDisk() {
  if (!db) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const data = db.export();
      fs.writeFileSync(DB_PATH, Buffer.from(data));
    } catch (err) {
      console.error('DB save error:', err.message);
    }
  }, SAVE_DEBOUNCE_MS);
}

// ── Query helpers (synchronous wrappers around sql.js) ─────────────────────────

function run(sql, params = {}) {
  const stmt = db.prepare(sql);
  stmt.run(params);
  stmt.free();
  saveToDisk(); // schedule disk write
}

function all(sql, params = {}) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function get(sql, params = {}) {
  return all(sql, params)[0] || null;
}

// ── Public API ─────────────────────────────────────────────────────────────────

const stmts = {
  // ── Users ──────────────────────────────────────────────────────────────────
  createUser(u) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    run(`INSERT INTO users (id, username, password, role, created_at, parent_id)
         VALUES (:id, :username, :password, :role, :created_at, :parent_id)`, {
      ':id': id, ':username': u.username, ':password': u.password,
      ':role': u.role || 'admin', ':created_at': new Date().toISOString(),
      ':parent_id': u.parent_id || null
    });
    return id;
  },

  getUserByUsername(username) {
    return get(`SELECT * FROM users WHERE username = :u`, { ':u': username });
  },

  getUserById(id) {
    return get(`SELECT id, username, role, created_at, parent_id FROM users WHERE id = :id`, { ':id': id });
  },

  listUsers(parentId = null) {
    if (parentId) {
      return all(`SELECT id, username, role, created_at FROM users WHERE parent_id = :parent ORDER BY created_at ASC`, {':parent': parentId});
    }
    return all(`SELECT id, username, role, created_at, parent_id FROM users ORDER BY created_at ASC`);
  },

  getAsesoresByOwner(ownerId) {
    return all(`SELECT id, username FROM users WHERE role = 'asesor' AND parent_id = :owner ORDER BY created_at ASC`, { ':owner': ownerId });
  },

  deleteUser(id) {
    run(`DELETE FROM users WHERE id = :id`, { ':id': id });
  },

  updatePassword(id, hashedPassword) {
    run(`UPDATE users SET password = :pw WHERE id = :id`, { ':id': id, ':pw': hashedPassword });
  },

  // ── Batches ────────────────────────────────────────────────────────────────
  insertBatch(b) {
    run(`INSERT INTO batches (id,name,total,session_mode,delay_ms,template,owner_id,created_at)
         VALUES (:id,:name,:total,:session_mode,:delay_ms,:template,:owner_id,:created_at)`, {
      ':id': b.id, ':name': b.name, ':total': b.total,
      ':session_mode': b.session_mode, ':delay_ms': b.delay_ms,
      ':template': b.template, ':owner_id': b.owner_id || null,
      ':created_at': b.created_at
    });
  },

  completeBatch(b) {
    run(`UPDATE batches SET sent=:sent, errors=:errors, completed_at=:completed_at WHERE id=:id`, {
      ':id': b.id, ':sent': b.sent, ':errors': b.errors, ':completed_at': b.completed_at
    });
  },

  getBatches(limit, ownerId = null) {
    if (ownerId) {
      return all(`SELECT * FROM batches WHERE owner_id = :owner ORDER BY created_at DESC LIMIT :limit`,
        { ':owner': ownerId, ':limit': limit });
    }
    return all(`SELECT * FROM batches ORDER BY created_at DESC LIMIT :limit`, { ':limit': limit });
  },

  getBatch(id, ownerId = null) {
    if (ownerId) {
      return get(`SELECT * FROM batches WHERE id = :id AND owner_id = :owner`,
        { ':id': id, ':owner': ownerId });
    }
    return get(`SELECT * FROM batches WHERE id = :id`, { ':id': id });
  },

  insertMessage(m) {
    run(`INSERT OR IGNORE INTO messages (id,batch_id,numero,cuenta,mensaje_final,session_used,status,timestamp)
         VALUES (:id,:batch_id,:numero,:cuenta,:mensaje_final,:session_used,:status,:timestamp)`, {
      ':id': m.id, ':batch_id': m.batch_id, ':numero': m.numero,
      ':cuenta': m.cuenta, ':mensaje_final': m.mensaje_final,
      ':session_used': m.session_used, ':status': m.status, ':timestamp': m.timestamp
    });
  },

  updateMessage(m) {
    run(`UPDATE messages SET status=:status, error=:error, message_id=:message_id, timestamp=:timestamp WHERE id=:id`, {
      ':id': m.id, ':status': m.status, ':error': m.error,
      ':message_id': m.message_id, ':timestamp': m.timestamp
    });
  },

  getMessages(batchId) {
    return all(`SELECT * FROM messages WHERE batch_id = :bid ORDER BY rowid ASC LIMIT 2000`, { ':bid': batchId });
  },

  getMessagesFiltered(batchId, status) {
    return all(`SELECT * FROM messages WHERE batch_id = :bid AND status = :status ORDER BY rowid ASC`, {
      ':bid': batchId, ':status': status
    });
  },



  // ── Replies ────────────────────────────────────────────────────────────────
  insertReply(r) {
    run(`INSERT OR IGNORE INTO replies (id, session_id, from_number, author_name, message_text, timestamp, is_read, asesor_id)
         VALUES (:id, :session_id, :from_number, :author_name, :message_text, :timestamp, 0, :asesor_id)`, {
      ':id': r.id, ':session_id': r.session_id, ':from_number': r.from_number,
      ':author_name': r.author_name || '', ':message_text': r.message_text || '',
      ':timestamp': r.timestamp, ':asesor_id': r.asesor_id || null
    });
  },

  getLatestReplyFromNumber(sessionId, fromNumber) {
    return get(`SELECT * FROM replies WHERE session_id = :sid AND from_number = :num ORDER BY timestamp DESC LIMIT 1`, {
      ':sid': sessionId, ':num': fromNumber
    });
  },

  getReplyCountFromNumber(sessionId, fromNumber) {
    const row = get(`SELECT COUNT(*) as cnt FROM replies WHERE session_id = :sid AND from_number = :num`, {
      ':sid': sessionId, ':num': fromNumber
    });
    return row ? row.cnt : 0;
  },

  getReplies(ownerId = null, limit = 500, asesorId = null) {
    if (asesorId) {
      return all(`
        SELECT r.*, s.label as session_name 
        FROM replies r
        LEFT JOIN sessions s ON r.session_id = s.client_id
        WHERE r.asesor_id = :asesor
        ORDER BY r.timestamp DESC
        LIMIT :limit
      `, { ':asesor': asesorId, ':limit': limit });
    }
    if (ownerId) {
      return all(`
        SELECT r.*, s.label as session_name 
        FROM replies r
        JOIN sessions s ON r.session_id = s.client_id
        WHERE s.owner_id = :owner
        ORDER BY r.timestamp DESC
        LIMIT :limit
      `, { ':owner': ownerId, ':limit': limit });
    }
    return all(`
      SELECT r.*, s.label as session_name 
      FROM replies r
      LEFT JOIN sessions s ON r.session_id = s.client_id
      ORDER BY r.timestamp DESC
      LIMIT :limit
    `, { ':limit': limit });
  },

  getUnreadRepliesCount(ownerId = null) {
    if (ownerId) {
      const row = get(`
        SELECT COUNT(*) as c FROM replies r
        JOIN sessions s ON r.session_id = s.client_id
        WHERE s.owner_id = :owner AND r.is_read = 0
      `, { ':owner': ownerId });
      return row ? row.c : 0;
    }
    const row = get(`SELECT COUNT(*) as c FROM replies WHERE is_read = 0`);
    return row ? row.c : 0;
  },

  markReplyRead(id) {
    run(`UPDATE replies SET is_read = 1 WHERE id = :id`, { ':id': id });
  },

  markAllRepliesRead(ownerId = null) {
    if (ownerId) {
      run(`
        UPDATE replies SET is_read = 1 
        WHERE id IN (
          SELECT r.id FROM replies r
          JOIN sessions s ON r.session_id = s.client_id
          WHERE s.owner_id = :owner
        )
      `, { ':owner': ownerId });
    } else {
      run(`UPDATE replies SET is_read = 1`);
    }
  },

  // ── Session persistence ────────────────────────────────────────────────────
  insertSession(s) {
    run(`INSERT OR REPLACE INTO sessions (client_id, label, owner_id, proxy, ai_enabled, ai_prompt, created_at)
         VALUES (:client_id, :label, :owner_id, :proxy, :ai_enabled, :ai_prompt, :created_at)`, {
      ':client_id': s.clientId, ':label': s.label || s.clientId,
      ':owner_id': s.owner_id || null,
      ':proxy': s.proxy || null,
      ':ai_enabled': s.ai_enabled ? 1 : 0,
      ':ai_prompt': s.ai_prompt || null,
      ':created_at': s.created_at || new Date().toISOString()
    });
  },

  updateSessionAI(clientId, enabled, prompt) {
    run(`UPDATE sessions SET ai_enabled = :en, ai_prompt = :pr WHERE client_id = :id`, {
      ':id': clientId, ':en': enabled ? 1 : 0, ':pr': prompt
    });
  },

  updateSessionProxy(clientId, proxy) {
    run(`UPDATE sessions SET proxy = :proxy WHERE client_id = :id`, {
      ':id': clientId, ':proxy': proxy
    });
  },

  // Actualizar perfil de historial de la sesión
  updateSessionHistory(clientId, hasHistory, historyLevel) {
    run(`UPDATE sessions SET has_history = :has, history_level = :lvl, history_set_at = :at WHERE client_id = :id`, {
      ':id': clientId,
      ':has': hasHistory ? 1 : 0,
      ':lvl': historyLevel,
      ':at': new Date().toISOString()
    });
  },

  // Obtener perfil completo de una sesión (para el frontend)
  getSessionProfile(clientId) {
    return get(`SELECT client_id, label, has_history, history_level, history_set_at, ai_enabled, proxy, created_at 
                FROM sessions WHERE client_id = :id`, { ':id': clientId });
  },

  deleteSession(clientId) {
    run(`DELETE FROM sessions WHERE client_id = :id`, { ':id': clientId });
  },

  getSessionOwner(clientId) {
    const row = get(`SELECT owner_id FROM sessions WHERE client_id = :id`, { ':id': clientId });
    return row ? row.owner_id : null;
  },

  getAllSessions() {
    return all(`SELECT * FROM sessions ORDER BY created_at ASC`);
  },

  // ── Proxy Pool ────────────────────────────────────────────────────────────
  addProxiesToPool(urls) {
    const stmt = db.prepare(`INSERT OR IGNORE INTO proxy_pool (url) VALUES (:url)`);
    urls.forEach(url => {
      if (url && url.trim()) stmt.run({ ':url': url.trim() });
    });
    stmt.free();
    saveToDisk();
  },

  getAvailableProxy(clientId) {
    const proxy = get(`SELECT * FROM proxy_pool WHERE is_used = 0 LIMIT 1`);
    if (proxy) {
      run(`UPDATE proxy_pool SET is_used = 1, session_id = :sid WHERE id = :id`, {
        ':sid': clientId, ':id': proxy.id
      });
      return proxy.url;
    }
    return null;
  },

  releaseProxy(clientId) {
    run(`UPDATE proxy_pool SET is_used = 0, session_id = NULL WHERE session_id = :sid`, {
      ':sid': clientId
    });
  },

  updateProxySession(clientId, newProxyUrl) {
    // Release old
    run(`UPDATE proxy_pool SET is_used = 0, session_id = NULL WHERE session_id = :sid`, { ':sid': clientId });
    // If new exists in pool, mark it
    if (newProxyUrl) {
      run(`UPDATE proxy_pool SET is_used = 1, session_id = :sid WHERE url = :url`, {
        ':sid': clientId, ':url': newProxyUrl.trim()
      });
    }
  },

  getProxyStats() {
    const total = get(`SELECT COUNT(*) as c FROM proxy_pool`);
    const used  = get(`SELECT COUNT(*) as c FROM proxy_pool WHERE is_used = 1`);
    return { total: total ? total.c : 0, used: used ? used.c : 0 };
  },

  clearProxyPool() {
    run(`DELETE FROM proxy_pool`);
  },

  getProxies() {
    return all(`SELECT * FROM proxy_pool ORDER BY is_used ASC, id DESC`);
  },

  // ── Stats globales ─────────────────────────────────────────────────────────
  getTotalStats(ownerId = null) {
    if (ownerId) {
      const msgs   = get(`SELECT COUNT(*) as total, SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) as sent, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as errors FROM messages m JOIN batches b ON m.batch_id = b.id WHERE b.owner_id = :owner`, { ':owner': ownerId });
      const batches = get(`SELECT COUNT(*) as cnt FROM batches WHERE owner_id = :owner`, { ':owner': ownerId });
      return { total: msgs?.total || 0, sent: msgs?.sent || 0, errors: msgs?.errors || 0, batches: batches?.cnt || 0 };
    }
    const msgs   = get(`SELECT COUNT(*) as total, SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) as sent, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as errors FROM messages`);
    const batches = get(`SELECT COUNT(*) as cnt FROM batches`);
    return { total: msgs?.total || 0, sent: msgs?.sent || 0, errors: msgs?.errors || 0, batches: batches?.cnt || 0 };
  },

  // ── Sessions por dueño ─────────────────────────────────────────────────────
  getSessionsByOwner(ownerId) {
    return all(`SELECT * FROM sessions WHERE owner_id = :owner`, { ':owner': ownerId });
  },

  // ── CRM Inbox ──────────────────────────────────────────────────────────────

  // Contactos agrupados por número que han respondido en una sesión
  getReplyContacts(clientId, ownerId, limit = 500) {
    const params = { ':session': clientId, ':limit': limit || 500 };
    let ownerFilter = '';
    if (ownerId) {
      ownerFilter = `AND r.owner_id = :owner`;
      params[':owner'] = ownerId;
    }
    return all(`
      SELECT
        r.from_number,
        r.session_id,
        MAX(r.message) as last_message,
        MAX(r.received_at) as last_time,
        SUM(CASE WHEN r.is_read = 0 THEN 1 ELSE 0 END) as unread_count,
        MAX(r.tag) as tag,
        MAX(r.cuenta) as cuenta
      FROM replies r
      WHERE r.session_id = :session ${ownerFilter}
      GROUP BY r.from_number, r.session_id
      ORDER BY last_time DESC
      LIMIT :limit
    `, params);
  },

  // Hilo de conversación: combina mensajes enviados + respuestas recibidas
  getConversationMessages(sessionId, fromNumber) {
    const params = { ':session': sessionId, ':from': fromNumber };
    // Mensajes enviados (outbound)
    const sent = all(`
      SELECT
        m.id, m.numero as from_number, m.mensaje_final as message,
        m.session_used as session_id, m.timestamp as ts,
        'out' as direction, m.status
      FROM messages m
      WHERE m.session_used = :session AND m.numero = :from
      ORDER BY m.timestamp ASC
    `, params);
    // Respuestas recibidas (inbound)
    const received = all(`
      SELECT
        r.id, r.from_number, r.message, r.session_id,
        r.received_at as ts, 'in' as direction,
        r.is_read, r.tag, r.cuenta
      FROM replies r
      WHERE r.session_id = :session AND r.from_number = :from
      ORDER BY r.received_at ASC
    `, params);

    return [...sent, ...received].sort((a, b) => new Date(a.ts) - new Date(b.ts));
  },

  // Marcar como leída toda la conversación de un número+sesión
  markConversationRead(sessionId, fromNumber) {
    run(`UPDATE replies SET is_read = 1
         WHERE session_id = :session AND from_number = :from AND is_read = 0`,
      { ':session': sessionId, ':from': fromNumber });
    schedSave();
  },

  // Etiquetar conversación (guarda la etiqueta en el último reply del contacto)
  tagConversation(sessionId, fromNumber, tag) {
    run(`UPDATE replies SET tag = :tag
         WHERE session_id = :session AND from_number = :from`,
      { ':tag': tag, ':session': sessionId, ':from': fromNumber });
    schedSave();
  },

  // Eliminar un reply individual
  deleteReply(id) {
    run(`DELETE FROM replies WHERE id = :id`, { ':id': id });
    schedSave();
  },
};


function deleteBatchFull(batchId) {
  run(`DELETE FROM messages WHERE batch_id = :id`, { ':id': batchId });
  run(`DELETE FROM batches WHERE id = :id`,         { ':id': batchId });
}

// Force final save on shutdown
process.on('exit', () => {
  if (db) {
    clearTimeout(saveTimer);
    try {
      const data = db.export();
      fs.writeFileSync(DB_PATH, Buffer.from(data));
    } catch (_) {}
  }
});

module.exports = { init, stmts, deleteBatchFull };

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
      role       TEXT DEFAULT 'user',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      client_id  TEXT PRIMARY KEY,
      label      TEXT,
      owner_id   TEXT,
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
  `);

  // ── Migrations: add columns if they don't exist (for existing DBs) ──────────
  const migrations = [
    `ALTER TABLE sessions ADD COLUMN owner_id TEXT`,
    `ALTER TABLE batches  ADD COLUMN owner_id TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_sess_owner  ON sessions(owner_id)`,
    `CREATE INDEX IF NOT EXISTS idx_batch_owner ON batches(owner_id)`,
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
    run(`INSERT INTO users (id, username, password, role, created_at)
         VALUES (:id, :username, :password, :role, :created_at)`, {
      ':id': id, ':username': u.username, ':password': u.password,
      ':role': u.role || 'user', ':created_at': new Date().toISOString()
    });
    return id;
  },

  getUserByUsername(username) {
    return get(`SELECT * FROM users WHERE username = :u`, { ':u': username });
  },

  getUserById(id) {
    return get(`SELECT id, username, role, created_at FROM users WHERE id = :id`, { ':id': id });
  },

  listUsers() {
    return all(`SELECT id, username, role, created_at FROM users ORDER BY created_at ASC`);
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
    run(`INSERT OR IGNORE INTO replies (id, session_id, from_number, author_name, message_text, timestamp, is_read)
         VALUES (:id, :session_id, :from_number, :author_name, :message_text, :timestamp, 0)`, {
      ':id': r.id, ':session_id': r.session_id, ':from_number': r.from_number,
      ':author_name': r.author_name || '', ':message_text': r.message_text || '', ':timestamp': r.timestamp
    });
  },

  getReplies(ownerId = null, limit = 500) {
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
    run(`INSERT OR REPLACE INTO sessions (client_id, label, owner_id, created_at)
         VALUES (:client_id, :label, :owner_id, :created_at)`, {
      ':client_id': s.clientId, ':label': s.label || s.clientId,
      ':owner_id': s.owner_id || null,
      ':created_at': s.created_at || new Date().toISOString()
    });
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

  getSessionsByOwner(ownerId) {
    return all(`SELECT * FROM sessions WHERE owner_id = :owner ORDER BY created_at ASC`,
      { ':owner': ownerId });
  },

  getTotalStats(ownerId = null) {
    if (ownerId) {
      return get(`
        SELECT
          COUNT(*) as total_messages,
          SUM(CASE WHEN m.status='sent'  THEN 1 ELSE 0 END) as total_sent,
          SUM(CASE WHEN m.status='error' THEN 1 ELSE 0 END) as total_errors,
          COUNT(DISTINCT m.batch_id) as total_batches
        FROM messages m
        JOIN batches b ON b.id = m.batch_id
        WHERE b.owner_id = :owner
      `, { ':owner': ownerId });
    }
    return get(`
      SELECT
        COUNT(*) as total_messages,
        SUM(CASE WHEN status='sent'  THEN 1 ELSE 0 END) as total_sent,
        SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as total_errors,
        COUNT(DISTINCT batch_id) as total_batches
      FROM messages
    `);
  }
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

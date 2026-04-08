/**
 * auth.js — Autenticación JWT con bcryptjs
 * Roles: 'superadmin' | 'admin'
 * Token expiry: 24h
 */
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');

const JWT_SECRET  = process.env.JWT_SECRET || 'wa_sender_secret_change_me_in_prod';
const JWT_EXPIRES = '24h';
const SALT_ROUNDS = 10;

// ── Crypto helpers ─────────────────────────────────────────────────────────────

async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// ── JWT helpers ────────────────────────────────────────────────────────────────

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ── Express middlewares ────────────────────────────────────────────────────────

/** Extracts and validates JWT. Attaches payload to req.user. Returns 401 if invalid. */
function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) return res.status(401).json({ error: 'No autenticado. Se requiere token.' });

  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Token inválido o expirado.' });

  req.user = payload; // { id, username, role }
  next();
}

/** Only allows superadmin role. Must run after requireAuth. */
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'superadmin')
    return res.status(403).json({ error: 'Acceso restringido a superadmin.' });
  next();
}

// ── Bootstrap superadmin ───────────────────────────────────────────────────────

/**
 * Ensures at least one superadmin exists.
 * Called once after DB is ready.
 */
async function ensureSuperAdmin(db) {
  const existing = db.getUserByUsername('superadmin');
  if (!existing) {
    const hashed = await hashPassword('admin1234');
    db.createUser({ username: 'superadmin', password: hashed, role: 'superadmin' });
    console.log('👤 Usuario superadmin creado con contraseña por defecto: admin1234');
    console.log('   ⚠️  Cambia esta contraseña desde el panel de administración.');
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  requireAuth,
  requireAdmin,
  ensureSuperAdmin,
};

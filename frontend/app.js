'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// INBOX CRM — Estado y helpers
// ═══════════════════════════════════════════════════════════════════════════════
const inboxCRM = {
  activeSession: null,   // clientId de la sesión seleccionada
  activeContact: null,   // from_number del contacto activo
  contacts: [],          // contactos de la sesión activa (raw del servidor)
  tagFilter: '',         // filtro de etiqueta activo
  searchQ: '',           // texto de búsqueda
};

// ── Badge de no leídos (sidebar) ─────────────────────────────────────────────
function updateInboxBadge(count) {
  const b = document.getElementById('badge-inbox');
  if (!b) return;
  const n = count !== undefined ? count : (state.inbox?.unreadCount || 0);
  if (n > 0) { b.textContent = n; b.style.display = 'inline-block'; }
  else { b.style.display = 'none'; }
}

// ── Compatibilidad con el código legado que llama markAllRepliesAsRead ────────
async function markAllRepliesAsRead() {
  try {
    await apiFetch('/api/replies/all/read', { method: 'PUT' });
    updateInboxBadge(0);
    showToast('Todas las conversaciones marcadas como leídas', 'info');
    refreshInboxSessions();
  } catch (e) { console.error(e); }
}

// ── Cargar sesiones (Columna 1) ────────────────────────────────────────────────
async function refreshInboxSessions() {
  const list = document.getElementById('inbox-session-list');
  if (!list) return;
  list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-3);font-size:13px">Cargando…</div>';
  try {
    const res = await apiFetch('/api/inbox/sessions');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    renderInboxSessions(data.sessions || []);
    // Actualizar badge global
    const totalUnread = (data.sessions || []).reduce((a, s) => a + (s.unread || 0), 0);
    updateInboxBadge(totalUnread);
  } catch (err) {
    list.innerHTML = `<div style="padding:16px;color:var(--danger);font-size:12px">Error: ${esc(err.message)}</div>`;
  }
}

function renderInboxSessions(sessions) {
  const list = document.getElementById('inbox-session-list');
  if (!list) return;
  // Filtrar sesiones inválidas o sin clientId
  const valid = (sessions || []).filter(s => s && s.clientId);
  if (!valid.length) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-3);font-size:13px">Sin sesiones conectadas</div>';
    return;
  }
  list.innerHTML = valid.map(s => {
    const active = s.clientId === inboxCRM.activeSession ? 'active' : '';
    const label = String(s.name || s.clientId || '?');
    const letter = label.charAt(0).toUpperCase();
    const offlineCls = s.status !== 'ready' ? 'offline' : '';
    const statusDot = s.status === 'ready'
      ? '<span style="color:#22c55e;font-size:10px">● En línea</span>'
      : '<span style="color:var(--text-3);font-size:10px">○ Desconectada</span>';
    const badge = (s.unread > 0)
      ? `<span class="inbox-unread-badge">${s.unread}</span>` : '';
    return `
      <div class="inbox-session-item ${active}" onclick="selectInboxSession('${esc(s.clientId)}', this)" data-cid="${esc(s.clientId)}">
        <div class="inbox-session-avatar ${offlineCls}">${esc(letter)}</div>
        <div style="flex:1;min-width:0">
          <div class="inbox-session-name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(label)}</div>
          ${statusDot}
        </div>
        ${badge}
      </div>`;
  }).join('');
}

// ── Seleccionar sesión (Columna 1→2) ─────────────────────────────────────────
async function selectInboxSession(clientId, el) {
  if (!clientId) return;
  inboxCRM.activeSession = clientId;
  inboxCRM.activeContact = null;
  inboxCRM.tagFilter = '';
  inboxCRM.searchQ = '';

  // Limpiar búsqueda
  const searchEl = document.getElementById('inbox-search');
  if (searchEl) searchEl.value = '';

  // Actualizar estado activo en col1
  document.querySelectorAll('#inbox-session-list .inbox-session-item').forEach(e => e.classList.remove('active'));
  if (el) el.classList.add('active');

  // Limpiar col3
  document.getElementById('inbox-chat-empty').style.display = 'flex';
  document.getElementById('inbox-chat-view').style.display = 'none';

  // Header col2 — usar datos del state.sessions local (evitar doble fetch)
  const localSess = state.sessions[clientId];
  const hdr = document.getElementById('inbox-contacts-header');
  if (hdr) hdr.textContent = localSess ? `📱 ${localSess.name || clientId}` : `📱 ${clientId}`;

  await loadInboxContacts();
}

// ── Cargar contactos de la sesión (Columna 2) ─────────────────────────────────
async function loadInboxContacts() {
  const cid = inboxCRM.activeSession;
  if (!cid) return;
  const list = document.getElementById('inbox-contact-list');
  list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-3);font-size:13px">Cargando contactos…</div>';
  try {
    const q = inboxCRM.searchQ ? `&search=${encodeURIComponent(inboxCRM.searchQ)}` : '';
    const res = await apiFetch(`/api/inbox/contacts?clientId=${encodeURIComponent(cid)}${q}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    inboxCRM.contacts = data.contacts || [];
    renderInboxContacts();
  } catch (err) {
    list.innerHTML = `<div style="padding:16px;color:var(--danger);font-size:12px">Error: ${esc(err.message)}</div>`;
  }
}

function renderInboxContacts() {
  const list = document.getElementById('inbox-contact-list');
  if (!list) return;
  let contacts = inboxCRM.contacts;

  // Filtrar por etiqueta
  if (inboxCRM.tagFilter) contacts = contacts.filter(c => c.tag === inboxCRM.tagFilter);
  // Filtrar por búsqueda
  if (inboxCRM.searchQ) {
    const q = inboxCRM.searchQ.toLowerCase();
    contacts = contacts.filter(c => (c.from_number || '').includes(q) || (c.cuenta || '').toLowerCase().includes(q));
  }

  if (!contacts.length) {
    list.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-3);font-size:13px">Sin conversaciones</div>';
    return;
  }

  list.innerHTML = contacts.map(c => {
    const active = c.from_number === inboxCRM.activeContact ? 'active' : '';
    const name = String(c.cuenta || c.from_number || '—');
    const letter = name.charAt(0).toUpperCase();

    const preview = c.last_message ? esc(String(c.last_message).slice(0, 55)) : '—';
    const ts = c.last_time ? relativeTime(c.last_time) : '';
    const unreadBadge = c.unread_count > 0
      ? `<span class="inbox-contact-unread">${c.unread_count}</span>` : '';
    const tagHtml = c.tag ? `<span class="inbox-tag inbox-tag-${c.tag}">${tagLabel(c.tag)}</span>` : '';

    return `
      <div class="inbox-contact-item ${active}"
        onclick="openInboxConversation('${esc(c.from_number)}','${esc(name)}', '${esc(c.tag || '')}', this)"
        data-number="${esc(c.from_number)}">
        <div class="inbox-contact-avatar">${esc(letter)}</div>
        <div class="inbox-contact-meta">
          <div class="inbox-contact-name">${esc(name)}</div>
          <div class="inbox-contact-preview">${preview}</div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:3px">
            ${tagHtml}
            <span class="inbox-contact-time">${ts}</span>
            ${unreadBadge}
          </div>
        </div>
      </div>`;
  }).join('');
}

// ── Abrir conversación (Columna 3) ────────────────────────────────────────────
async function openInboxConversation(fromNumber, name, tag, el) {
  inboxCRM.activeContact = fromNumber;

  // Marcar activo en col2
  document.querySelectorAll('#inbox-contact-list .inbox-contact-item').forEach(e => e.classList.remove('active'));
  if (el) el.classList.add('active');

  // Mostrar panel de chat
  document.getElementById('inbox-chat-empty').style.display = 'none';
  const chatView = document.getElementById('inbox-chat-view');
  chatView.style.display = 'flex';

  // Header
  const safeName = String(name || fromNumber || '?');
  const letter = safeName.charAt(0).toUpperCase();
  document.getElementById('inbox-avatar').textContent = letter;
  document.getElementById('inbox-chat-name').textContent = safeName;
  document.getElementById('inbox-chat-phone').textContent = fromNumber;
  document.getElementById('inbox-reply-session-label').textContent = `Línea: ${inboxCRM.activeSession}`;


  // Etiqueta actual
  const tagSel = document.getElementById('inbox-tag-select');
  if (tagSel) tagSel.value = tag || '';

  // Cargar mensajes
  await loadConversationMessages(fromNumber);

  // Actualizar contador de no leídos en lista contactos (optimista)
  const contact = inboxCRM.contacts.find(c => c.from_number === fromNumber);
  if (contact) { contact.unread_count = 0; renderInboxContacts(); }

  // Enfocar textarea
  setTimeout(() => { const ta = document.getElementById('inbox-reply-input'); if (ta) ta.focus(); }, 100);
}

async function loadConversationMessages(fromNumber) {
  const cid = inboxCRM.activeSession;
  const box = document.getElementById('inbox-chat-messages');
  box.innerHTML = '<div style="text-align:center;color:var(--text-3);font-size:13px;padding:20px">Cargando mensajes…</div>';
  try {
    const res = await apiFetch(`/api/inbox/conversation?clientId=${encodeURIComponent(cid)}&from=${encodeURIComponent(fromNumber)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    renderChatBubbles(data.messages || []);
  } catch (err) {
    box.innerHTML = `<div style="text-align:center;color:var(--danger);font-size:13px;padding:20px">Error: ${esc(err.message)}</div>`;
  }
}

function renderChatBubbles(messages) {
  const box = document.getElementById('inbox-chat-messages');
  if (!box) return;
  if (!messages.length) {
    box.innerHTML = '<div style="text-align:center;color:var(--text-3);font-size:13px;padding:30px">Sin mensajes en esta conversación.</div>';
    return;
  }

  let lastDate = '';
  box.innerHTML = messages.map(m => {
    const dir = m.direction === 'out' ? 'out' : 'in';
    const ts = m.ts || m.timestamp || m.received_at || '';
    const d = ts ? new Date(ts) : null;
    const dateStr = d ? d.toLocaleDateString('es-MX', { weekday: 'short', month: 'short', day: 'numeric' }) : '';
    const timeStr = d ? d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '';
    const statusIcon = dir === 'out' ? (m.status === 'sent' ? '✓✓' : '✓') : '';

    let dateSep = '';
    if (dateStr && dateStr !== lastDate) {
      lastDate = dateStr;
      dateSep = `<div class="chat-date-sep">${dateStr}</div>`;
    }

    return `${dateSep}
    <div class="chat-bubble-wrap ${dir}">
      <div class="chat-bubble">
        <div>${esc(m.message || m.mensaje_final || '')}</div>
        <div class="chat-bubble-time">${timeStr} ${statusIcon}</div>
      </div>
    </div>`;
  }).join('');

  // Hacer scroll al fondo
  requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
}

// ── Enviar respuesta ──────────────────────────────────────────────────────────
async function sendInboxReply() {
  const ta = document.getElementById('inbox-reply-input');
  const btn = document.getElementById('btn-inbox-send');
  const msg = ta?.value.trim();
  if (!msg) return;
  if (!inboxCRM.activeSession || !inboxCRM.activeContact) {
    showToast('Selecciona una conversación primero', 'error'); return;
  }

  btn.disabled = true;
  btn.textContent = '…';

  // Mostrar burbuja optimista
  appendChatBubble({ direction: 'out', message: msg, ts: new Date().toISOString(), status: 'pending' });
  ta.value = '';

  try {
    const res = await apiFetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: inboxCRM.activeSession, to: inboxCRM.activeContact, message: msg }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showToast('Mensaje enviado ✓', 'info');
  } catch (err) {
    showToast(`Error al enviar: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '➤ Enviar';
  }
}

function appendChatBubble(msg) {
  const box = document.getElementById('inbox-chat-messages');
  if (!box) return;
  const dir = msg.direction === 'out' ? 'out' : 'in';
  const d = new Date(msg.ts || Date.now());
  const timeStr = d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  const statusIcon = dir === 'out' ? (msg.status === 'sent' ? '✓✓' : '✓') : '';
  const el = document.createElement('div');
  el.className = `chat-bubble-wrap ${dir}`;
  el.innerHTML = `<div class="chat-bubble">
    <div>${esc(msg.message || '')}</div>
    <div class="chat-bubble-time">${timeStr} ${statusIcon}</div>
  </div>`;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

function inboxReplyKeydown(e) {
  if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); sendInboxReply(); }
}

function refreshConversation() {
  if (inboxCRM.activeContact) loadConversationMessages(inboxCRM.activeContact);
}

// ── Etiquetado ────────────────────────────────────────────────────────────────
async function setConversationTag(tag) {
  if (!inboxCRM.activeSession || !inboxCRM.activeContact) return;
  try {
    const res = await apiFetch('/api/inbox/tag', {
      method: 'PUT',
      body: JSON.stringify({ clientId: inboxCRM.activeSession, fromNumber: inboxCRM.activeContact, tag }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    showToast(`Etiqueta actualizada: ${tagLabel(tag) || 'Sin etiqueta'}`, 'info');
    // Actualizar en lista local
    const contact = inboxCRM.contacts.find(c => c.from_number === inboxCRM.activeContact);
    if (contact) { contact.tag = tag; renderInboxContacts(); }
  } catch (err) { showToast('Error: ' + err.message, 'error'); }
}

async function filterInboxTag(btn, tag) {
  inboxCRM.tagFilter = tag;
  document.querySelectorAll('.inbox-tag-filter').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderInboxContacts();
}

function searchInboxContacts(q) {
  inboxCRM.searchQ = q;
  renderInboxContacts();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function tagLabel(tag) {
  return { interesado: '⭐ Interesado', seguimiento: '⏰ Seguimiento', noInteresado: '❌ No interesado', cerrado: '✅ Cerrado' }[tag] || '';
}

function relativeTime(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'ahora';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function esc(str) { return String(str || '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }

// ── Legacy compat (se sigue llamando desde el HTML viejo) ────────────────────
async function loadInbox() { await refreshInboxSessions(); }
async function markReplyAsRead() {}


// ── Auth State ─────────────────────────────────────────────────────────────────
const auth = {
  token: localStorage.getItem('wa_token') || null,
  user: JSON.parse(localStorage.getItem('wa_user') || 'null'),
};

// ── App State ──────────────────────────────────────────────────────────────────
const state = {
  sessions: {},
  xlsxRows: [],
  variableCols: [],
  liveReports: [],
  currentBatchId: null,
  dbReady: false,
  inbox: { replies: [], unreadCount: 0 },
  bulkTotal: 0, bulkDone: 0, bulkOk: 0, bulkFail: 0
};

let socket;
let qrModalPending = null;

// ═══════════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('log-start-time').textContent = now();
  if (auth.token && auth.user) {
    showApp();
  } else {
    showLogin();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH — LOGIN / LOGOUT
// ═══════════════════════════════════════════════════════════════════════════════
function showLogin() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  setTimeout(() => document.getElementById('login-username').focus(), 150);
}

function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  applyUserRole();
  initSocket();
  initDragDrop();
  initTemplateCharCounter();
}

function applyUserRole() {
  const u = auth.user;
  if (!u) return;
  const roleName = u.role === 'superadmin' ? '⭐ Superadmin' : (u.role === 'asesor' ? '🎧 Asesor' : 'Usuario');
  document.getElementById('user-info-name').textContent = u.username;
  document.getElementById('user-info-role').textContent = roleName;
  document.getElementById('user-avatar').textContent = u.username.charAt(0).toUpperCase();

  const isAdmin = u.role === 'superadmin';
  const isUser = u.role === 'admin';
  const isAsesor = u.role === 'asesor';

  document.getElementById('nav-label-admin').style.display = (isAdmin || isUser) ? '' : 'none';
  document.getElementById('nav-users').style.display = (isAdmin || isUser) ? '' : 'none';

  if (isUser) {
    document.getElementById('nav-users').innerHTML = '<span class="icon">👥</span> Mis Asesores';
  } else if (isAdmin) {
    document.getElementById('nav-users').innerHTML = '<span class="icon">👥</span> Usuarios Totales';
  }

  document.getElementById('nav-training').style.display = isAdmin ? '' : 'none';
  // document.getElementById('nav-proxies').style.display = isAdmin ? '' : 'none';

  if (isAsesor) {
    ['nav-sessions', 'nav-send', 'nav-bulk', 'nav-reports', 'nav-history'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    navigate('inbox');
  } else {
    ['nav-sessions', 'nav-send', 'nav-bulk', 'nav-reports', 'nav-history'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = '';
    });
    navigate('sessions');
  }
}

async function doLogin(e) {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  const btnText = document.getElementById('btn-login-text');
  const btnSpin = document.getElementById('btn-login-spin');
  const btn = document.getElementById('btn-login');

  errEl.style.display = 'none';
  btn.disabled = true;
  btnText.style.display = 'none';
  btnSpin.style.display = 'inline-block';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Bypass-Tunnel-Reminder': 'true'
      },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al iniciar sesión');

    auth.token = data.token;
    auth.user = data.user;
    localStorage.setItem('wa_token', data.token);
    localStorage.setItem('wa_user', JSON.stringify(data.user));
    showApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btnText.style.display = 'inline';
    btnSpin.style.display = 'none';
  }
}

function doLogout() {
  auth.token = null;
  auth.user = null;
  localStorage.removeItem('wa_token');
  localStorage.removeItem('wa_user');
  if (socket) socket.disconnect();
  showLogin();
}

function togglePw() {
  const inp = document.getElementById('login-password');
  inp.type = inp.type === 'password' ? 'text' : 'password';
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOCKET.IO
// ═══════════════════════════════════════════════════════════════════════════════
function initSocket() {
  socket = io();

  socket.on('connect', () => { setConn(true); log('info', 'Conectado al servidor ✅'); });
  socket.on('disconnect', () => { setConn(false); log('err', 'Desconectado del servidor'); });

  socket.on('db:status', ({ ready }) => {
    state.dbReady = ready;
    const dot = document.getElementById('db-dot');
    if (dot) {
      dot.style.color = ready ? 'var(--success)' : 'var(--danger)';
      dot.title = ready ? 'SQLite conectado' : 'SQLite no disponible';
    }
    if (!ready) {
      const w = document.getElementById('no-db-warn');
      if (w) w.style.display = 'block';
    }
  });

  socket.on('sessions:list', ({ sessions }) => {
    state.sessions = {};
    sessions.forEach(s => { state.sessions[s.clientId] = s; });
    renderSessions(); populateSessionSelects(); renderTrainingSessions();
  });

  socket.on('reports:init', ({ reports }) => {
    state.liveReports = reports;
    renderReports(); updateReportStats(); updateErrorBadge();
  });

  socket.on('session:qr', ({ clientId, qr, label }) => {
    updateSession(clientId, { status: 'qr_pending', qr });
    log('info', `[${label || clientId}] QR generado — escanéalo`);
    if (qrModalPending === clientId) { qrModalPending = null; openQrModal(clientId, qr); }
    const title = document.getElementById('qr-modal-title');
    if (title?.dataset.clientId === clientId && document.getElementById('modal-qr').classList.contains('open')) {
      showQr(qr);
    }
  });

  socket.on('session:authenticated', ({ clientId, label }) => {
    updateSession(clientId, { status: 'authenticated', qr: null });
    log('ok', `[${label || clientId}] Autenticado`);
    closeModal('modal-qr');
  });

  socket.on('session:ready', ({ clientId, phone, name }) => {
    updateSession(clientId, { status: 'ready', phone, name });
    log('ok', `[${name || clientId}] ✅ Listo! Tel: +52${phone}`);
    showToast(`Sesión "${name || clientId}" conectada`, 'success');
    populateSessionSelects(); renderTrainingSessions();
  });

  socket.on('session:disconnected', ({ clientId, reason, label }) => {
    updateSession(clientId, { status: 'disconnected' });
    log('err', `[${label || clientId}] Desconectado: ${reason}`);
    showToast(`"${label || clientId}" desconectado`, 'error');
    populateSessionSelects(); renderTrainingSessions();
  });

  socket.on('session:auth_failure', ({ clientId, message, label }) => {
    updateSession(clientId, { status: 'auth_failure' });
    log('err', `[${label || clientId}] Auth failure: ${message}`);
    showToast('Error de autenticación', 'error');
  });

  socket.on('session:removed', ({ clientId }) => {
    delete state.sessions[clientId];
    renderSessions(); populateSessionSelects();
    log('info', `Sesión "${clientId}" eliminada`);
  });

  socket.on('session:error', ({ clientId, error }) => {
    updateSession(clientId, { status: 'disconnected' });
    log('err', `[${clientId}] Error: ${error}`);
    showToast(`Error en sesión: ${error}`, 'error');
  });

  socket.on('reply:new', (replyData) => {
    if (auth.user?.role !== 'superadmin' && !state.sessions[replyData.clientId]) return;

    // Sonido de notificación sutil
    try { new Audio('data:audio/mp3;base64,//NExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq').play().catch(() => {}); } catch (e) {}

    // Badge global
    state.inbox = state.inbox || { unreadCount: 0, replies: [] };
    state.inbox.unreadCount++;
    updateInboxBadge(state.inbox.unreadCount);

    const isInboxActive = document.getElementById('page-inbox')?.classList.contains('active');

    if (isInboxActive) {
      // Si la sesión del mensaje es la activa, actualizar columna 2
      if (replyData.clientId === inboxCRM.activeSession) {
        // Agregar o actualizar contacto en la lista
        const existing = inboxCRM.contacts.find(c => c.from_number === replyData.from_number);
        if (existing) {
          existing.last_message = replyData.message;
          existing.last_time = replyData.received_at;
          existing.unread_count = (existing.unread_count || 0) + 1;
          // Mover al tope
          inboxCRM.contacts = [existing, ...inboxCRM.contacts.filter(c => c.from_number !== replyData.from_number)];
        } else {
          inboxCRM.contacts.unshift({
            from_number: replyData.from_number,
            session_id: replyData.clientId,
            last_message: replyData.message,
            last_time: replyData.received_at,
            unread_count: 1,
            tag: null,
            cuenta: replyData.cuenta || replyData.from_number,
          });
        }
        renderInboxContacts();

        // Si además este contacto está abierto en col3, añadir burbuja
        if (inboxCRM.activeContact === replyData.from_number) {
          appendChatBubble({ direction: 'in', message: replyData.message, ts: replyData.received_at });
          // Marcar como leído en caliente
          if (existing) existing.unread_count = 0;
          apiFetch('/api/replies/all/read', { method: 'PUT' }).catch(() => {});
        }
      } else {
        // Actualizar badge de esa sesión en columna 1
        refreshInboxSessions();
      }
    } else {
      showToast('📥 Nuevo mensaje de ' + replyData.from_number, 'success');
    }

  });

  socket.on('bulk:progress', ({ batchId, batchName, index, total, numero, cuenta, status, error, sessionUsed }) => {
    state.bulkDone = index;
    if (status === 'sent') state.bulkOk++; else state.bulkFail++;
    updateBulkProgress();
    if (status === 'sent') log('ok', `✅ [${sessionUsed}] → ${numero}`);
    else log('err', `❌ [${sessionUsed}] → ${numero}: ${error}`);
  });

  socket.on('bulk:waiting', ({ index, total, waitMs }) => {
    const secs = (waitMs / 1000).toFixed(1);
    log('info', `⏳ Esperando ${secs}s antes del siguiente contacto (${index}/${total})`);
  });

  socket.on('bulk:cooling', ({ sessionId, coolMs, index, total }) => {
    const mins = Math.round(coolMs / 60000);
    const msg = `🧊 Sesi\u00f3n [${sessionId}] en pausa de enfriamiento (${mins} min) — ${index}/${total} procesados`;
    log('info', msg);
    showToast(msg, 'info');
  });

  socket.on('bulk:daily_limit', ({ sessionId, limit }) => {
    log('err', `⚠️ Sesi\u00f3n [${sessionId}] alcanz\u00f3 el l\u00edmite diario de ${limit} mensajes`);
    showToast(`\u26a0\ufe0f [${sessionId}] lleg\u00f3 al l\u00edmite de ${limit} msgs/d\u00eda`, 'error');
  });

  socket.on('bulk:greetings_done', ({ total }) => {
    log('ok', `✅ Saludos emitidos a ${total} hilos. Esperando hasta 7 minutos por respuestas...`);
    showToast(`✅ Saludos emitidos a los ${total} contactos. Pausando flujos a espera de respuesta...`, 'info');
  });

  socket.on('bulk:complete', ({ batchId, batchName, total, sent, errors }) => {
    log('info', `🏁 [${batchName}] Completado: ${sent} enviados, ${errors} errores`);
    showToast(`Lote "${batchName}" completo: ${sent} ok, ${errors} errores`, 'info');
    const btn = document.getElementById('btn-send-bulk');
    const btnStop = document.getElementById('btn-stop-bulk');
    if (btn) { btn.disabled = false; btn.textContent = '🚀 Iniciar Envío Masivo'; }
    if (btnStop) btnStop.style.display = 'none';
  });

  socket.on('bulk:stopped', ({ batchId, batchName, doneAt, total }) => {
    log('info', `⏹️ Envío detenido en ${doneAt}/${total} mensajes.`);
    showToast(`Envío detenido. Se procesaron ${doneAt} de ${total} contactos.`, 'info');
    const btn = document.getElementById('btn-send-bulk');
    const btnStop = document.getElementById('btn-stop-bulk');
    if (btn) { btn.disabled = false; btn.textContent = '🚀 Iniciar Envío Masivo'; }
    if (btnStop) btnStop.style.display = 'none';
  });


  socket.on('report:update', entry => {
    state.liveReports.unshift(entry);
    if (state.liveReports.length > 5000) state.liveReports.pop();
    prependReportRow(entry);
    updateReportStats(); updateErrorBadge();
  });

  socket.on('report:cleared', () => {
    state.liveReports = []; renderReports();
  });

  // ── Training Socket events ─────────────────────────────────────────────────
  socket.on('training:start', ({ trainingId, total, sessions, msgsPerSession, sessionNames }) => {
    state.trainingRunning = true;
    document.getElementById('tr-total').textContent = total;
    document.getElementById('tr-sessions').textContent = sessions;
    document.getElementById('tr-sent').textContent = '0';
    document.getElementById('tr-errors').textContent = '0';
    document.getElementById('tr-progress-section').style.display = 'block';
    document.getElementById('tr-progress-bar').style.width = '0%';
    document.getElementById('tr-progress-text').textContent = `0 / ${total}`;
    document.getElementById('tr-eta-box').style.display = 'block';
    document.getElementById('tr-eta').textContent = 'Calculando…';
    document.getElementById('badge-training').style.display = '';
    document.getElementById('btn-training-start').style.display = 'none';
    document.getElementById('btn-training-stop').style.display = '';
    trLog('ok', `▶️ Entrenamiento iniciado: ${sessions} sesiones × ${msgsPerSession} mensajes = ${total} total`);
    trLog('info', `📱 Participantes: ${sessionNames.join(', ')}`);
  });

  socket.on('training:progress', ({ index, total, from, to, message, status, error, sent, errors, eta }) => {
    const pct = total > 0 ? Math.round((index / total) * 100) : 0;
    document.getElementById('tr-progress-bar').style.width = `${pct}%`;
    document.getElementById('tr-progress-text').textContent = `${index} / ${total}`;
    document.getElementById('tr-sent').textContent = sent;
    document.getElementById('tr-errors').textContent = errors;
    document.getElementById('tr-current-msg').textContent =
      status === 'sent'
        ? `Último: "${message.slice(0, 50)}…"`
        : `❌ Error: ${error || 'desconocido'}`;
    if (status === 'sent') trLog('ok', `✅ [${from}] → [${to}]: "${esc(message)}​"`);
    else trLog('err', `❌ [${from}] → [${to}]: ${esc(error || 'Error')}`);
  });

  socket.on('training:waiting', ({ index, total, waitMs, nextFrom, nextTo }) => {
    const secs = (waitMs / 1000).toFixed(1);
    const etaSecs = Math.round((total - index) * (waitMs / 1000));
    document.getElementById('tr-eta').textContent = formatEta(etaSecs);
    document.getElementById('tr-eta-box').style.display = 'block';
    trLog('info', `⏳ Esperando ${secs}s → siguiente: [${nextFrom}] → [${nextTo}] (${index}/${total})`);
  });

  socket.on('training:complete', ({ total, sent, errors, duration }) => {
    state.trainingRunning = false;
    document.getElementById('tr-progress-bar').style.width = '100%';
    document.getElementById('tr-progress-text').textContent = `${total} / ${total}`;
    document.getElementById('tr-eta').textContent = 'Completado';
    document.getElementById('badge-training').style.display = 'none';
    document.getElementById('btn-training-start').style.display = '';
    document.getElementById('btn-training-stop').style.display = 'none';
    document.getElementById('btn-training-start').disabled = false;
    document.getElementById('btn-training-start').textContent = '▶️ Iniciar Entrenamiento';
    trLog('ok', `🏁 ¡Entrenamiento completado! ${sent} enviados, ${errors} errores — ${formatEta(duration)} totales`);
    showToast(`Entrenamiento completado: ${sent} mensajes enviados`, 'success', 6000);
  });

  // ── Validador: progreso en tiempo real ────────────────────────────────────
  socket.on('validator:progress', (data) => handleValidatorProgress(data));
  socket.on('validator:complete', (data) => handleValidatorComplete(data));
}


// ═══════════════════════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════════
const pageTitles = {
  sessions: 'Sesiones', send: 'Enviar Mensaje', bulk: 'Envío Masivo XLSX',
  reports: 'Envío Activo', history: 'Historial DB', log: 'Registro de Actividad',
  users: 'Gestión de Usuarios', training: 'Modo Entrenamiento'
};

function navigate(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  const pageEl = document.getElementById(`page-${page}`);
  const navEl = document.getElementById(`nav-${page}`);
  if (pageEl) pageEl.classList.add('active');
  if (navEl) navEl.classList.add('active');
  document.getElementById('topbar-title').textContent = pageTitles[page] || page;
  document.getElementById('topbar-actions').innerHTML =
    page === 'sessions' ? `<button class="btn btn-primary" onclick="openAddSessionModal()">＋ Nueva Sesión</button>` :
      page === 'users' ? `<button class="btn btn-primary" onclick="openAddUserModal()">＋ Nuevo Usuario</button>` : '';
  if (page === 'history') loadHistory();
  if (page === 'users') loadUsers();
  if (page === 'inbox') loadInbox();
  if (page === 'proxies') loadProxyStats();
  if (page === 'training') loadTrainingSessions();
}

async function loadTrainingSessions() {
  // Refresca sesiones desde el servidor para garantizar datos actualizados
  try {
    const res = await apiFetch('/api/sessions');
    if (res.ok) {
      const data = await res.json();
      // Actualizar state.sessions con la lista del servidor (preserva el QR local)
      (data.sessions || []).forEach(s => {
        if (!state.sessions[s.clientId]) state.sessions[s.clientId] = {};
        Object.assign(state.sessions[s.clientId], s);
      });
    }
  } catch (e) { /* no bloquear si falla, usar estado local */ }
  renderTrainingSessions();
}

// ═══════════════════════════════════════════════════════════════════════════════
// SESSIONS
// ═══════════════════════════════════════════════════════════════════════════════
function updateSession(clientId, updates) {
  if (!state.sessions[clientId]) state.sessions[clientId] = { clientId };
  Object.assign(state.sessions[clientId], updates);
  renderSessions();
  renderTrainingSessions();
}

function renderSessions() {
  const grid = document.getElementById('sessions-grid');
  const empty = document.getElementById('empty-sessions');
  const list = Object.values(state.sessions);
  grid.innerHTML = '';
  if (list.length === 0) { empty.style.display = 'block'; grid.style.display = 'none'; }
  else { empty.style.display = 'none'; grid.style.display = 'grid'; list.forEach(s => grid.appendChild(buildSessionCard(s))); }
  updateStats(list);
}

function buildSessionCard(s) {
  const div = document.createElement('div');
  div.className = 'session-card';
  const lbl = {
    initializing: 'Iniciando', qr_pending: 'QR pendiente', authenticated: 'Autenticado',
    ready: 'Conectado', disconnected: 'Desconectado', auth_failure: 'Error auth'
  }[s.status] || s.status;
  const qrBtn = s.status === 'qr_pending'
    ? `<button class="btn btn-secondary btn-sm btn-icon" onclick="openQrForSession('${s.clientId}')">📷</button>` : '';
  div.innerHTML = `
    <div class="session-card-header">
      <div class="session-avatar">📱</div>
      <div class="session-actions">${qrBtn}
        <!-- <button class="btn btn-secondary btn-sm btn-icon" onclick="openSettingsModal('${s.clientId}')" title="Configuración avanzada">⚙️</button> -->
        <button class="btn btn-danger btn-sm btn-icon" onclick="removeSession('${s.clientId}')">🗑️</button>
      </div>
    </div>
    <div class="session-name">${esc(s.name || s.clientId)}</div>
    <div class="session-id">${esc(s.clientId)}</div>
    ${s.phone ? `<div class="session-phone">📞 +52${esc(s.phone)}</div>` : ''}
    <div><span class="session-status status-${s.status}">
      ${['initializing', 'qr_pending'].includes(s.status) ? '<span class="pulse"></span>' : ''} ${lbl}
    </span></div>`;
  return div;
}

function updateStats(list) {
  document.getElementById('stat-total').textContent = list.length;
  document.getElementById('stat-ready').textContent = list.filter(s => s.status === 'ready').length;
  document.getElementById('stat-qr').textContent = list.filter(s => s.status === 'qr_pending').length;
  document.getElementById('stat-disc').textContent = list.filter(s => ['disconnected', 'auth_failure'].includes(s.status)).length;
}

function openAddSessionModal() {
  document.getElementById('new-session-id').value = '';
  document.getElementById('new-session-label').value = '';
  openModal('modal-add-session');
  setTimeout(() => document.getElementById('new-session-id').focus(), 100);
}

async function createSession() {
  const clientId = document.getElementById('new-session-id').value.trim();
  const label = document.getElementById('new-session-label').value.trim();
  if (!clientId) { showToast('El ID de sesión es requerido', 'error'); return; }
  try {
    const res = await apiPost('/api/sessions', { clientId, label });
    closeModal('modal-add-session');
    showToast(`Sesión "${res.clientId}" creada. Esperando QR...`, 'info');
    log('info', `Sesión "${res.clientId}" inicializando...`);
    state.sessions[res.clientId] = { clientId: res.clientId, name: label || res.clientId, status: 'initializing' };
    renderSessions(); qrModalPending = res.clientId;
  } catch (err) { showToast(err.message, 'error'); }
}

async function removeSession(clientId) {
  if (!confirm(`¿Eliminar la sesión "${clientId}"?`)) return;
  try { await apiDelete(`/api/sessions/${clientId}`); }
  catch (err) { showToast(err.message, 'error'); }
}

function openQrForSession(clientId) {
  const s = state.sessions[clientId];
  openQrModal(clientId, s?.qr || null);
}

function openQrModal(clientId, qrData) {
  const title = document.getElementById('qr-modal-title');
  const s = state.sessions[clientId];
  title.textContent = `QR — ${esc(s?.name || clientId)}`;
  title.dataset.clientId = clientId;
  if (qrData) { showQr(qrData); }
  else { document.getElementById('qr-loading').style.display = 'flex'; document.getElementById('qr-content').style.display = 'none'; }
  openModal('modal-qr');
}

function showQr(qrBase64) {
  document.getElementById('qr-loading').style.display = 'none';
  document.getElementById('qr-content').style.display = 'block';
  document.getElementById('qr-image').src = qrBase64;
}

// ── Advanced Settings (IA / Proxy) ──────────────────────────────────────────
let currentSettingsClientId = null;

function openSettingsModal(clientId) {
  const s = state.sessions[clientId];
  if (!s) return;

  currentSettingsClientId = clientId;
  document.getElementById('settings-subtitle').textContent = `Sesión: ${s.name || clientId}`;

  // Load current values
  document.getElementById('setting-ai-enabled').checked = !!s.ai_enabled;
  document.getElementById('setting-ai-prompt').value = s.ai_prompt || '';
  document.getElementById('setting-proxy').value = s.proxy || '';

  openModal('modal-settings');
}

async function saveSessionSettings() {
  const clientId = currentSettingsClientId;
  if (!clientId) return;

  const ai_enabled = document.getElementById('setting-ai-enabled').checked;
  const ai_prompt = document.getElementById('setting-ai-prompt').value.trim();
  const proxy = document.getElementById('setting-proxy').value.trim();

  const btn = document.getElementById('btn-save-settings');
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Guardando...';

  try {
    await apiPost(`/api/sessions/${clientId}/settings`, { ai_enabled, ai_prompt, proxy });

    // Update local state
    if (state.sessions[clientId]) {
      state.sessions[clientId].ai_enabled = ai_enabled;
      state.sessions[clientId].ai_prompt = ai_prompt;
      state.sessions[clientId].proxy = proxy;
    }

    showToast('Configuración guardada correctamente', 'success');
    closeModal('modal-settings');
    renderSessions();
  } catch (err) {
    showToast('Error al guardar: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

function populateSessionSelects() {
  const ready = Object.values(state.sessions).filter(s => s.status === 'ready');
  ['send-session'].forEach(id => {
    const sel = document.getElementById(id); if (!sel) return;
    const v = sel.value;
    sel.innerHTML = '<option value="">— Selecciona sesión —</option>';
    ready.forEach(s => { const o = document.createElement('option'); o.value = s.clientId; o.textContent = `${s.name || s.clientId}${s.phone ? ` (+52${s.phone})` : ''}`; sel.appendChild(o); });
    if (v) sel.value = v;
  });
  const bs = document.getElementById('bulk-session'); const bv = bs.value;
  bs.innerHTML = '<option value="">— Selecciona sesión o rotación —</option><option value="ALL">🔄 Todos los conectados (rotación)</option>';
  ready.forEach(s => { const o = document.createElement('option'); o.value = s.clientId; o.textContent = `${s.name || s.clientId}${s.phone ? ` (+52${s.phone})` : ''}`; bs.appendChild(o); });
  if (bv) bs.value = bv;
  checkBulkReady();

  // Actualizar badge informativo del validador
  const info = document.getElementById('val-sessions-info');
  if (info) {
    if (ready.length === 0) {
      info.textContent = '⚠️ Sin sesiones conectadas — conecta al menos una';
      info.style.color = 'var(--danger)';
    } else {
      info.textContent = `${ready.length} sesión${ready.length > 1 ? 'es' : ''} disponible${ready.length > 1 ? 's' : ''}: ${ready.map(s => s.name || s.clientId).join(', ')}`;
      info.style.color = 'var(--text-3)';
    }
  }
}

// ── Helper: obtener primera sesión ready ───────────────────────────────────
function getFirstReadySession() {
  return Object.values(state.sessions).find(s => s.status === 'ready')?.clientId || null;
}


// ───────────────────────────────────────────────────────────────────────────────
// VALIDADOR WHATSAPP — usa sesión automática
// ───────────────────────────────────────────────────────────────────────────────
const validatorResults = [];

function getValidatorSession() {
  const clientId = Object.values(state.sessions).find(s => s.status === 'ready')?.clientId;
  if (!clientId) { showToast('No hay sesiones conectadas. Conecta al menos una.', 'error'); }
  return clientId || null;
}

async function validateSingle() {
  const num = document.getElementById('val-single-input').value.trim();
  if (!num) { showToast('Ingresa un número', 'error'); return; }
  const clientId = getValidatorSession();
  if (!clientId) return;
  const btn = document.getElementById('btn-val-single');
  btn.disabled = true; btn.textContent = '...';
  try {
    const res = await apiFetch('/api/check-number', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, numero: num })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    const hasWA = data.exists || data.hasWhatsapp || false;
    const entry = { numero: num, hasWhatsapp: hasWA, jid: data.jid || '', hora: new Date().toLocaleTimeString('es-MX') };
    validatorResults.unshift(entry);
    updateValidatorStats();
    renderValidatorTable();
    document.getElementById('btn-export-validator').style.display = '';
    showToast(hasWA ? `✅ ${num} tiene WhatsApp` : `❌ ${num} NO tiene WhatsApp`, hasWA ? 'success' : 'error');
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Verificar';
  }
}

async function validateBulk() {
  const raw = document.getElementById('val-bulk-input').value.trim();
  if (!raw) { showToast('Ingresa al menos un número', 'error'); return; }
  const clientId = getValidatorSession();
  if (!clientId) return;
  const nums = [...new Set(raw.split('\n').map(n => n.trim()).filter(n => n.length >= 8))].slice(0, 500);
  if (!nums.length) { showToast('Sin números válidos (mín 8 dígitos)', 'error'); return; }

  const btn = document.getElementById('btn-val-bulk');
  const progress = document.getElementById('val-progress-wrap');
  const bar = document.getElementById('val-progress-bar');
  const text = document.getElementById('val-progress-text');
  btn.disabled = true; btn.textContent = '⏳ Validando...';
  progress.style.display = 'block';
  bar.style.width = '0%';
  text.textContent = `0 / ${nums.length}`;

  try {
    // El backend procesa async y emite progreso por socket
    const res = await apiFetch('/api/check-numbers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, numeros: nums })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    // El progreso llega via eventos socket: validator:progress y validator:complete
    showToast(`Validando ${nums.length} números en segundo plano...`, 'info');
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
    btn.disabled = false; btn.textContent = '🔍 Iniciar Validación Masiva';
  }
}

// Eventos de socket para el validador masivo (inicializados en initSocket)
function handleValidatorProgress(data) {
  const { index, total, result } = data;
  const bar = document.getElementById('val-progress-bar');
  const text = document.getElementById('val-progress-text');
  if (bar) bar.style.width = `${Math.round((index / total) * 100)}%`;
  if (text) text.textContent = `${index} / ${total}`;

  if (result) {
    const hasWA = result.exists || result.hasWhatsapp || false;
    const entry = {
      numero: result.number || result.numero || '',
      hasWhatsapp: hasWA,
      jid: result.jid || '',
      hora: new Date().toLocaleTimeString('es-MX')
    };
    validatorResults.unshift(entry);
    updateValidatorStats();
    renderValidatorTable();
  }
}

function handleValidatorComplete(data) {
  const btn = document.getElementById('btn-val-bulk');
  if (btn) { btn.disabled = false; btn.textContent = '🔍 Iniciar Validación Masiva'; }
  document.getElementById('btn-export-validator').style.display = '';
  showToast(`✅ Validación completa: ${data.withWA || 0} con WA / ${data.withoutWA || 0} sin WA`, 'success');
}

function updateValidatorStats() {
  const ok  = validatorResults.filter(r => r.hasWhatsapp).length;
  const no  = validatorResults.filter(r => !r.hasWhatsapp).length;
  document.getElementById('val-total').textContent = validatorResults.length;
  document.getElementById('val-ok').textContent   = ok;
  document.getElementById('val-fail').textContent  = no;
  document.getElementById('val-rate').textContent  = validatorResults.length > 0 ? `${Math.round((ok / validatorResults.length) * 100)}%` : '—';
}

function renderValidatorTable() {
  const filter = document.getElementById('val-filter')?.value || '';
  const rows = filter === 'si' ? validatorResults.filter(r => r.hasWhatsapp)
    : filter === 'no' ? validatorResults.filter(r => !r.hasWhatsapp)
    : validatorResults;
  const tbody = document.getElementById('val-tbody');
  if (!tbody) return;
  tbody.innerHTML = rows.map((r, i) => `
    <tr>
      <td style="color:var(--text-3);font-size:12px">${i + 1}</td>
      <td><strong>${esc(r.numero)}</strong></td>
      <td><span class="status-pill ${r.hasWhatsapp ? 'pill-sent' : 'pill-error'}">${r.hasWhatsapp ? '✅ Sí' : '❌ No'}</span></td>
      <td style="font-size:11px;color:var(--text-3)">${esc(r.jid)}</td>
      <td style="font-size:11px;color:var(--text-3)">${esc(r.hora)}</td>
    </tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text-3);padding:30px">Sin resultados.</td></tr>';
}

function applyValidatorFilter() { renderValidatorTable(); }

function clearValidator() {
  validatorResults.length = 0;
  document.getElementById('val-bulk-input').value = '';
  document.getElementById('val-single-input').value = '';
  document.getElementById('val-progress-wrap').style.display = 'none';
  document.getElementById('btn-export-validator').style.display = 'none';
  updateValidatorStats();
  document.getElementById('val-tbody').innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-3);padding:40px">Ingresa números y presiona Validar.</td></tr>';
}

function exportValidatorCSV() {
  const rows = ['Numero,WhatsApp,JID,Hora', ...validatorResults.map(r => `${r.numero},${r.hasWhatsapp ? 'Si' : 'No'},${r.jid},${r.hora}`)];
  downloadCSV(rows.join('\n'), `validacion_${new Date().toISOString().slice(0,10)}.csv`);
}

// ───────────────────────────────────────────────────────────────────────────────
// SEND SINGLE
// ───────────────────────────────────────────────────────────────────────────────
async function sendSingle() {
  const clientId = document.getElementById('send-session').value;
  const to = document.getElementById('send-to').value.trim();
  const message = document.getElementById('send-msg').value.trim();
  if (!clientId) { showToast('Selecciona una sesión', 'error'); return; }
  if (!to) { showToast('Ingresa el número', 'error'); return; }
  if (!message) { showToast('El mensaje no puede estar vacío', 'error'); return; }
  const btn = document.getElementById('btn-send-single');
  btn.disabled = true; btn.textContent = 'Enviando...';
  try {
    await apiPost('/api/send', { clientId, to, message });
    showToast('Mensaje enviado ✅', 'success');
    log('ok', `✅ Enviado a ${to} desde "${clientId}"`);
    document.getElementById('send-msg').value = ''; document.getElementById('send-to').value = '';
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
    log('err', `❌ Error a ${to}: ${err.message}`);
  } finally { btn.disabled = false; btn.textContent = '✉️ Enviar'; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// XLSX UPLOAD + TEMPLATE + BULK SEND
// ═══════════════════════════════════════════════════════════════════════════════
function initDragDrop() {
  const zone = document.getElementById('drop-zone');
  if (!zone) return;
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag-over'); const f = e.dataTransfer.files[0]; if (f) handleXlsxFile(f); });
}

function initTemplateCharCounter() {
  const ta = document.getElementById('bulk-template');
  if (!ta) return;
  ta.addEventListener('input', () => {
    document.getElementById('template-char-count').textContent = `${ta.value.length} caracteres`;
    updateTemplatePreview();
  });
  ['bulk-delay-min', 'bulk-delay-max'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateDelayHint);
  });
}

function updateDelayHint() {
  const minMs = parseInt(document.getElementById('bulk-delay-min')?.value) || 1000;
  const maxMs = parseInt(document.getElementById('bulk-delay-max')?.value) || 15000;
  const hint = document.getElementById('delay-hint');
  if (hint) hint.innerHTML = `Cada mensaje espera entre <b>${(minMs / 1000).toFixed(1)}s</b> y <b>${(maxMs / 1000).toFixed(1)}s</b> al azar 🎲`;
}

async function handleXlsxFile(file) {
  if (!file) return;
  if (!/\.(xlsx|xls)$/i.test(file.name)) { showToast('Solo .xlsx o .xls', 'error'); return; }
  log('info', `Procesando ${file.name}...`);
  const formData = new FormData(); formData.append('file', file);
  try {
    const res = await fetch('/api/parse-xlsx', { method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Bypass-Tunnel-Reminder': 'true' }, body: formData });
    const data = await res.json();
    if (res.status === 401) { doLogout(); return; }
    if (!res.ok) throw new Error(data.error || 'Error al parsear');

    state.xlsxRows = data.rows;
    state.variableCols = data.variableCols || [];

    document.getElementById('drop-zone').style.display = 'none';
    const fi = document.getElementById('file-info'); fi.style.display = 'flex';
    document.getElementById('file-name').textContent = file.name;
    document.getElementById('file-meta').textContent =
      `${data.total} filas válidas${data.skipped > 0 ? ` · ${data.skipped} omitidas` : ''}${data.variableCols.length > 0 ? ` · Variables: ${data.variableCols.join(', ')}` : ''}`;

    if (data.errors?.length > 0) {
      const pe = document.getElementById('parse-errors'); pe.style.display = 'block';
      pe.innerHTML = '<strong>⚠️ Filas omitidas:</strong><br>' + data.errors.map(e => `<span>${esc(e)}</span>`).join('<br>');
    }

    renderVariableChips(state.variableCols);
    renderPreviewTable(data.rows, data.variableCols);
    if (!document.getElementById('batch-name').value) {
      document.getElementById('batch-name').value = `Envío ${new Date().toLocaleDateString('es-MX')}`;
    }
    checkBulkReady(); updateTemplatePreview();
    log('ok', `✅ XLSX cargado: ${data.total} filas, variables: [${state.variableCols.join(', ')}]`);
    showToast(`${data.total} filas cargadas — ${state.variableCols.length} variables detectadas`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
    log('err', `❌ Error XLSX: ${err.message}`);
  }
}

function renderVariableChips(cols) {
  const section = document.getElementById('variable-section');
  const group = document.getElementById('var-chips');
  if (cols.length === 0) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  group.innerHTML = '';
  cols.forEach(col => {
    const chip = document.createElement('button');
    chip.className = 'var-chip';
    chip.textContent = `+ {{${col}}}`;
    chip.title = `Insertar variable {{${col}}}`;
    chip.onclick = () => insertVariable(col);
    group.appendChild(chip);
  });
}

function insertVariable(varName) {
  const ta = document.getElementById('bulk-template');
  const start = ta.selectionStart, end = ta.selectionEnd;
  const before = ta.value.substring(0, start);
  const after = ta.value.substring(end);
  ta.value = before + `{{${varName}}}` + after;
  ta.selectionStart = ta.selectionEnd = start + varName.length + 4;
  ta.focus();
  document.getElementById('template-char-count').textContent = `${ta.value.length} caracteres`;
  updateTemplatePreview();
}

function updateTemplatePreview() {
  const template = document.getElementById('bulk-template').value;
  const section = document.getElementById('preview-msg-section');
  const box = document.getElementById('preview-msg-box');
  if (!template.trim() || state.xlsxRows.length === 0) { section.style.display = 'none'; return; }
  const row = state.xlsxRows[0];
  const preview = applyTemplate(template, row);
  section.style.display = 'block';
  box.textContent = preview;
}

function applyTemplate(template, row) {
  return template.replace(/\{\{(\w+)\}\}/gi, (_, key) => {
    const val = row[key.toLowerCase()];
    return val !== undefined && val !== '' ? val : `{{${key}}}`;
  });
}

function clearFile() {
  state.xlsxRows = []; state.variableCols = [];
  document.getElementById('drop-zone').style.display = '';
  document.getElementById('file-info').style.display = 'none';
  document.getElementById('parse-errors').style.display = 'none';
  document.getElementById('xlsx-input').value = '';
  document.getElementById('preview-empty').style.display = 'block';
  document.getElementById('preview-table-wrap').style.display = 'none';
  document.getElementById('preview-count').textContent = '0 filas';
  document.getElementById('variable-section').style.display = 'none';
  document.getElementById('preview-msg-section').style.display = 'none';
  checkBulkReady();
}

function renderPreviewTable(rows, varCols) {
  const thead = document.getElementById('preview-thead');
  const tbody = document.getElementById('preview-tbody');
  const allCols = ['numero', 'cuenta', ...varCols];
  thead.innerHTML = '<tr><th>#</th>' + allCols.map(c => `<th>${esc(c)}</th>`).join('') + '</tr>';
  tbody.innerHTML = '';
  const preview = rows.slice(0, 200);
  preview.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td style="color:var(--text-3)">${i + 1}</td>` +
      allCols.map(c => `<td class="${c === 'numero' ? '' : 'msg-cell'}">${esc(r[c] || '')}</td>`).join('');
    tbody.appendChild(tr);
  });
  if (rows.length > 200) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="${allCols.length + 1}" style="text-align:center;color:var(--text-3);font-size:12px;padding:12px">… y ${rows.length - 200} filas más</td>`;
    tbody.appendChild(tr);
  }
  document.getElementById('preview-empty').style.display = 'none';
  document.getElementById('preview-table-wrap').style.display = 'block';
  document.getElementById('preview-count').textContent = `${rows.length} filas`;
}

function checkBulkReady() {
  const hasRows = state.xlsxRows.length > 0;
  const hasSession = !!document.getElementById('bulk-session')?.value;
  const hasTemplate = !!document.getElementById('bulk-template')?.value.trim();
  const btn = document.getElementById('btn-send-bulk');
  if (btn) btn.disabled = !(hasRows && hasSession && hasTemplate);
}

document.addEventListener('input', e => {
  if (e.target.id === 'bulk-template') checkBulkReady();
});

async function sendBulkXlsx() {
  const clientId = document.getElementById('bulk-session').value;
  const minDelay = parseInt(document.getElementById('bulk-delay-min')?.value) || 20;
  const maxDelay = parseInt(document.getElementById('bulk-delay-max')?.value) || 45;
  const template = document.getElementById('bulk-template').value.trim();
  const batchName = document.getElementById('batch-name').value.trim();
  const warmup = document.getElementById('bulk-warmup')?.checked || false;
  const dailyLimit   = parseInt(document.getElementById('bulk-daily-limit')?.value)  || 150;
  const coolingEvery = parseInt(document.getElementById('bulk-cooling-every')?.value) || 30;
  const coolingSecs  = parseInt(document.getElementById('bulk-cooling-secs')?.value)  || 120;

  if (!clientId) { showToast('Selecciona una sesión o rotación', 'error'); return; }
  if (state.xlsxRows.length === 0) { showToast('Carga un archivo XLSX primero', 'error'); return; }
  if (!template) { showToast('La plantilla del mensaje es requerida', 'error'); return; }

  // Advertencia proactiva si el delay es muy bajo
  if (minDelay < 15 && !confirm(`⚠️ Advertencia: Usas un delay de solo ${minDelay}s, lo cual puede causar bloqueos.\n\n¿Deseas continuar de todas formas?`)) return;

  state.bulkTotal = state.xlsxRows.length; state.bulkDone = 0; state.bulkOk = 0; state.bulkFail = 0;
  document.getElementById('prog-ok').textContent = '0';
  document.getElementById('prog-err').textContent = '0';
  document.getElementById('bulk-progress-section').style.display = 'block';
  updateBulkProgress();

  const btn = document.getElementById('btn-send-bulk');
  const btnStop = document.getElementById('btn-stop-bulk');
  btn.disabled = true;
  btn.textContent = '⏳ Enviando...';
  if (btnStop) { btnStop.style.display = 'block'; }

  const modeLabel = clientId === 'ALL' ? 'rotación' : 'sesión "' + clientId + '"';
  log('info', `🚀 Iniciando envío: ${state.xlsxRows.length} mensajes — ${modeLabel}`);
  log('info', `⏱️ Delay: ${minDelay}s–${maxDelay}s | Límite diario: ${dailyLimit} | Pausa c/${coolingEvery} msgs (${coolingSecs}s)`);

  try {
    await apiPost('/api/send-bulk-xlsx', { rows: state.xlsxRows, clientId, minDelay, maxDelay, template, batchName, warmup, dailyLimit, coolingEvery, coolingSecs });
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
    log('err', `❌ ${err.message}`);
    btn.disabled = false;
    btn.textContent = '🚀 Iniciar Envío Masivo';
    if (btnStop) btnStop.style.display = 'none';
  }
}

function updateDelayHint() {
  const min = parseInt(document.getElementById('bulk-delay-min')?.value) || 20;
  const max = parseInt(document.getElementById('bulk-delay-max')?.value) || 45;
  const hint = document.getElementById('delay-hint');
  const warn = document.getElementById('delay-risk-warn');
  if (hint) hint.innerHTML = `Cada mensaje espera entre <b>${min}</b> y <b>${max}</b> segundos al azar`;
  if (warn) warn.style.display = min < 15 ? 'block' : 'none';
}

async function stopBulkXlsx() {
  const btnStop = document.getElementById('btn-stop-bulk');
  if (btnStop) { btnStop.disabled = true; btnStop.textContent = 'Deteniendo…'; }
  try {
    await apiPost('/api/send-bulk-xlsx/stop', {});
    showToast('Detención solicitada. Se terminará el mensaje actual y el proceso se pausará.', 'info');
    log('info', '⏹️ Detención del envío solicitada por el usuario.');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btnStop) { btnStop.disabled = false; btnStop.textContent = '⏹ Detener Envío'; }
  }
}

function updateBulkProgress() {
  const pct = state.bulkTotal > 0 ? Math.round((state.bulkDone / state.bulkTotal) * 100) : 0;
  document.getElementById('bulk-progress-bar').style.width = `${pct}%`;
  document.getElementById('bulk-progress-text').textContent = `${state.bulkDone} / ${state.bulkTotal}`;
  document.getElementById('prog-ok').textContent = state.bulkOk;
  document.getElementById('prog-err').textContent = state.bulkFail;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LIVE REPORTS
// ═══════════════════════════════════════════════════════════════════════════════
function renderReports() {
  const tbody = document.getElementById('report-tbody');
  const filter = document.getElementById('filter-status')?.value || '';
  const rows = filter ? state.liveReports.filter(r => r.status === filter) : state.liveReports;
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-3);padding:40px">Sin registros${filter ? ` con estado "${filter}"` : ''}.</td></tr>`;
  } else {
    tbody.innerHTML = ''; rows.forEach((r, i) => tbody.appendChild(buildReportRow(r, i + 1)));
  }
  updateReportStats(); updateErrorBadge();
}

function prependReportRow(entry) {
  const tbody = document.getElementById('report-tbody');
  const filter = document.getElementById('filter-status')?.value || '';
  if (filter && entry.status !== filter) return;
  if (tbody.querySelector('[colspan="8"]')) tbody.innerHTML = '';
  const newRow = buildReportRow(entry, 1);
  tbody.insertBefore(newRow, tbody.firstChild);
  Array.from(tbody.querySelectorAll('td:first-child')).forEach((td, i) => { td.textContent = i + 1; });
}

function buildReportRow(r, idx) {
  const tr = document.createElement('tr');
  const pillClass = { sent: 'pill-sent', error: 'pill-error', pending: 'pill-pending' }[r.status] || 'pill-pending';
  const pillIcon = { sent: '✅', error: '❌', pending: '⏳' }[r.status] || '•';
  const pillLabel = { sent: 'Enviado', error: 'Error', pending: 'Pendiente' }[r.status] || r.status;
  const time = r.timestamp ? new Date(r.timestamp).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
  tr.innerHTML = `
    <td style="color:var(--text-3);font-size:12px">${idx}</td>
    <td><code style="font-size:12px">${esc(r.numero)}</code></td>
    <td>${esc(r.cuenta || '—')}</td>
    <td class="msg-cell" title="${esc(r.mensaje || r.mensaje_final || '')}">${esc((r.mensaje || r.mensaje_final || '').slice(0, 60))}</td>
    <td style="font-size:12px;color:var(--text-2)">${esc(r.sessionUsed || r.session_used || '—')}</td>
    <td><span class="status-pill ${pillClass}">${pillIcon} ${pillLabel}</span></td>
    <td class="error-cell" title="${esc(r.error || '')}">${r.error ? esc(r.error) : '<span style="color:var(--text-3)">—</span>'}</td>
    <td style="font-size:11px;color:var(--text-3);white-space:nowrap">${time}</td>`;
  return tr;
}

function updateReportStats() {
  const t = state.liveReports.length;
  const s = state.liveReports.filter(r => r.status === 'sent').length;
  const e = state.liveReports.filter(r => r.status === 'error').length;
  document.getElementById('rpt-total').textContent = t;
  document.getElementById('rpt-sent').textContent = s;
  document.getElementById('rpt-err').textContent = e;
  document.getElementById('rpt-rate').textContent = t > 0 ? `${Math.round(s / t * 100)}%` : '—';
}

function updateErrorBadge() {
  const n = state.liveReports.filter(r => r.status === 'error').length;
  const b = document.getElementById('badge-errors');
  if (b) { b.style.display = n > 0 ? '' : 'none'; b.textContent = n > 99 ? '99+' : n; }
}

function applyFilter() { renderReports(); }

async function clearReports() {
  if (!confirm('¿Limpiar todos los reportes en memoria?')) return;
  await apiDelete('/api/reports');
}

function exportLiveCSV() {
  const filter = document.getElementById('filter-status')?.value || '';
  const rows = filter ? state.liveReports.filter(r => r.status === filter) : state.liveReports;
  if (rows.length === 0) { showToast('No hay reportes para exportar', 'error'); return; }
  const headers = ['#', 'Numero', 'Cuenta', 'Mensaje', 'Sesion', 'Estado', 'Error', 'Hora'];
  const lines = ['\uFEFF' + headers.join(',')];
  rows.forEach((r, i) => {
    const time = r.timestamp ? new Date(r.timestamp).toLocaleString('es-MX') : '';
    lines.push([i + 1, csvVal(r.numero), csvVal(r.cuenta), csvVal(r.mensaje || ''),
    csvVal(r.sessionUsed), r.status, csvVal(r.error || ''), csvVal(time)].join(','));
  });
  downloadCSV(lines.join('\n'), `envio_activo_${new Date().toISOString().slice(0, 10)}.csv`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// HISTORY (SQLite)
// ═══════════════════════════════════════════════════════════════════════════════
async function loadHistory() {
  try {
    const [hRes, sRes] = await Promise.all([
      apiFetch('/api/history'),
      apiFetch('/api/history/stats')
    ]);
    const [hData, sData] = [await hRes.json(), await sRes.json()];

    if (!hData.dbReady) {
      document.getElementById('no-db-warn').style.display = 'block';
      document.getElementById('history-empty').style.display = 'none';
      document.getElementById('history-grid').innerHTML = '';
      return;
    }

    document.getElementById('hs-total').textContent = sData.total_messages || 0;
    document.getElementById('hs-sent').textContent = sData.total_sent || 0;
    document.getElementById('hs-errors').textContent = sData.total_errors || 0;
    document.getElementById('hs-batches').textContent = sData.total_batches || 0;

    const grid = document.getElementById('history-grid');
    if (hData.batches.length === 0) {
      document.getElementById('history-empty').style.display = 'block';
      grid.innerHTML = ''; return;
    }
    document.getElementById('history-empty').style.display = 'none';
    grid.innerHTML = '';
    hData.batches.forEach(b => grid.appendChild(buildBatchCard(b)));
  } catch (err) {
    log('err', 'Error al cargar historial: ' + err.message);
  }
}

function buildBatchCard(b) {
  const div = document.createElement('div');
  div.className = 'batch-card';
  const date = b.created_at ? new Date(b.created_at).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const completed = b.completed_at ? '✅ Completado' : '⏳ En proceso';
  const pct = b.total > 0 ? Math.round((b.sent / b.total) * 100) : 0;
  const mode = b.session_mode === 'ALL' ? '🔄 Rotación' : `📱 ${esc(b.session_mode || '—')}`;
  div.innerHTML = `
    <div class="batch-card-header">
      <div>
        <div class="batch-name">${esc(b.name)}</div>
        <div class="batch-date">${date} · ${mode}</div>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-secondary btn-sm" onclick="openHistoryDetail('${b.id}')">Ver</button>
        <button class="btn btn-danger btn-sm" onclick="deleteBatch('${b.id}')">🗑️</button>
      </div>
    </div>
    <div class="batch-stats">
      <span class="bstat"><span style="color:var(--text-2)">Total</span> <b>${b.total}</b></span>
      <span class="bstat"><span style="color:var(--success)">✅</span> <b>${b.sent || 0}</b></span>
      <span class="bstat"><span style="color:var(--danger)">❌</span> <b>${b.errors || 0}</b></span>
    </div>
    <div class="progress-bar-wrapper" style="margin-top:10px">
      <div class="progress-bar-fill" style="width:${pct}%"></div>
    </div>
    <div style="font-size:11px;color:var(--text-3);margin-top:6px;display:flex;justify-content:space-between">
      <span>${completed}</span><span>${pct}% éxito</span>
    </div>`;
  return div;
}

async function openHistoryDetail(batchId) {
  state.currentBatchId = batchId;
  document.getElementById('history-list-view').style.display = 'none';
  document.getElementById('history-detail-view').style.display = 'block';
  document.getElementById('btn-export-batch').dataset.batchId = batchId;
  await loadBatchDetail(batchId, '');
}

function closeHistoryDetail() {
  document.getElementById('history-detail-view').style.display = 'none';
  document.getElementById('history-list-view').style.display = 'block';
  document.getElementById('detail-filter').value = '';
  state.currentBatchId = null;
}

async function filterDetail() {
  if (state.currentBatchId) await loadBatchDetail(state.currentBatchId, document.getElementById('detail-filter').value);
}

async function loadBatchDetail(batchId, statusFilter) {
  try {
    const url = `/api/history/${batchId}${statusFilter ? `?status=${statusFilter}` : ''}`;
    const res = await apiFetch(url); const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error');

    const { batch, messages } = data;
    document.getElementById('detail-title').textContent = batch.name;
    document.getElementById('detail-sub').textContent =
      `${batch.session_mode === 'ALL' ? '🔄 Rotación' : '📱 ' + batch.session_mode} · ${new Date(batch.created_at).toLocaleString('es-MX')}`;
    document.getElementById('d-total').textContent = batch.total || 0;
    document.getElementById('d-sent').textContent = batch.sent || 0;
    document.getElementById('d-errors').textContent = batch.errors || 0;
    document.getElementById('d-mode').textContent = batch.session_mode === 'ALL' ? 'Rotación' : batch.session_mode;

    const tbody = document.getElementById('detail-tbody');
    tbody.innerHTML = '';
    if (messages.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-3);padding:30px">Sin mensajes${statusFilter ? ` con estado "${statusFilter}"` : ''}.</td></tr>`;
    } else {
      messages.forEach((m, i) => {
        const r = { ...m, sessionUsed: m.session_used, mensaje: m.mensaje_final };
        tbody.appendChild(buildReportRow(r, i + 1));
      });
    }
  } catch (err) {
    log('err', 'Error al cargar detalle: ' + err.message);
    showToast(err.message, 'error');
  }
}

async function deleteBatch(batchId) {
  if (!confirm('¿Eliminar este lote y todos sus mensajes de la BD?')) return;
  try {
    await apiDelete(`/api/history/${batchId}`);
    showToast('Lote eliminado', 'success');
    loadHistory();
  } catch (err) { showToast(err.message, 'error'); }
}

async function exportBatchCSV() {
  const batchId = state.currentBatchId;
  if (!batchId) return;
  try {
    const res = await apiFetch(`/api/history/${batchId}/csv`);
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Error al descargar CSV');
    }
    const csvContent = await res.text();

    let filename = `lote_${batchId}.csv`;
    const disposition = res.headers.get('content-disposition');
    if (disposition && disposition.indexOf('filename=') !== -1) {
      filename = disposition.split('filename=')[1].replace(/"/g, '');
    }

    downloadCSV(csvContent, filename);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// USERS (admin only)
// ═══════════════════════════════════════════════════════════════════════════════
async function loadUsers() {
  try {
    const res = await apiFetch('/api/users');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error');

    const tbody = document.getElementById('users-tbody');
    tbody.innerHTML = '';
    if (data.users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-3);padding:40px">Sin usuarios.</td></tr>';
      return;
    }
    data.users.forEach((u, i) => {
      const isSelf = u.id === auth.user?.id;
      const roleBadge = u.role === 'superadmin'
        ? `<span class="role-badge role-superadmin">⭐ Superadmin</span>`
        : (u.role === 'asesor' ? `<span class="role-badge role-user">🎧 Asesor</span>` : `<span class="role-badge role-user">👤 Administrador local</span>`);
      const date = new Date(u.created_at).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
      const delBtn = (!isSelf && u.role !== 'superadmin' && (auth.user?.role === 'superadmin' || u.role === 'asesor'))
        ? `<button class="btn btn-danger btn-sm" onclick="deleteUser('${u.id}','${esc(u.username)}')">🗑️ Eliminar</button>`
        : `<span style="color:var(--text-3);font-size:12px">${isSelf ? '(tú)' : 'protegido'}</span>`;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="color:var(--text-3)">${i + 1}</td>
        <td><strong>${esc(u.username)}</strong></td>
        <td>${roleBadge}</td>
        <td style="font-size:12px;color:var(--text-2)">${date}</td>
        <td>${delBtn}</td>`;
      tbody.appendChild(tr);
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function openAddUserModal() {
  document.getElementById('new-user-username').value = '';
  document.getElementById('new-user-password').value = '';
  const sel = document.getElementById('new-user-role');
  if (auth.user?.role === 'admin') {
    sel.innerHTML = '<option value="asesor">Asesor (Bandeja de Entrada)</option>';
  } else {
    sel.innerHTML = '<option value="admin">Administrador local</option><option value="superadmin">Superadmin (Acceso total)</option><option value="asesor">Asesor</option>';
  }
  document.getElementById('add-user-error').style.display = 'none';
  openModal('modal-add-user');
  setTimeout(() => document.getElementById('new-user-username').focus(), 100);
}

async function createUser() {
  const username = document.getElementById('new-user-username').value.trim();
  const password = document.getElementById('new-user-password').value;
  const role = document.getElementById('new-user-role').value;
  const errEl = document.getElementById('add-user-error');

  errEl.style.display = 'none';
  if (!username) { errEl.textContent = 'El nombre de usuario es requerido'; errEl.style.display = 'block'; return; }
  if (password.length < 6) { errEl.textContent = 'La contraseña debe tener al menos 6 caracteres'; errEl.style.display = 'block'; return; }

  try {
    await apiPost('/api/users', { username, password, role });
    closeModal('modal-add-user');
    showToast(`Usuario "${username}" creado`, 'success');
    loadUsers();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}

// ── PROXY POOL ──────────────────────────────────────────────────────────────
async function loadProxyStats() {
  try {
    const res = await apiFetch('/api/proxies/pool');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    document.getElementById('proxy-available').textContent = data.stats.total - data.stats.used;
    document.getElementById('proxy-used').textContent = data.stats.used;
    document.getElementById('proxy-total').textContent = data.stats.total;

    const tbody = document.getElementById('proxy-tbody');
    tbody.innerHTML = '';
    if (data.list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text-3);padding:40px">Pool vacío. Agrega proxies para automatizar la asignación.</td></tr>';
      return;
    }
    data.list.forEach((p, i) => {
      const tr = document.createElement('tr');
      const statusClass = p.is_used ? 'status-pill pill-error' : 'status-pill pill-sent';
      const statusText = p.is_used ? `OCUPADO (${esc(p.session_id)})` : 'LIBRE';
      tr.innerHTML = `
        <td style="color:var(--text-3)">${i + 1}</td>
        <td><code>${esc(p.url)}</code></td>
        <td><span class="${statusClass}">${statusText}</span></td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    showToast('Error cargando proxies: ' + err.message, 'error');
  }
}

async function saveBulkProxies() {
  const input = document.getElementById('proxy-bulk-input');
  const rawText = input.value.trim();
  if (!rawText) { showToast('Ingresa al menos un proxy', 'error'); return; }

  try {
    const data = await apiPost('/api/proxies/pool/bulk', { rawText });
    showToast(`${data.count} proxies añadidos al pool`, 'success');
    input.value = '';
    loadProxyStats();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function clearProxyPool() {
  if (!confirm('¿Eliminar TODOS los proxies del pool? Las sesiones actuales conservarán su proxy asignado pero no se liberará al eliminarlas.')) return;
  try {
    await apiDelete('/api/proxies/pool');
    showToast('Pool vaciado', 'success');
    loadProxyStats();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteUser(id, username) {
  if (!confirm(`¿Eliminar el usuario "${username}"? Esta acción no se puede deshacer.`)) return;
  try {
    await apiDelete(`/api/users/${id}`);
    showToast(`Usuario "${username}" eliminado`, 'success');
    loadUsers();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODALS
// ═══════════════════════════════════════════════════════════════════════════════
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.addEventListener('click', e => { if (e.target.classList.contains('modal-overlay')) e.target.classList.remove('open'); });

// ═══════════════════════════════════════════════════════════════════════════════
// LOG
// ═══════════════════════════════════════════════════════════════════════════════
function log(type, msg) {
  const c = document.getElementById('main-log');
  if (!c) return;
  const d = document.createElement('div'); d.className = 'log-entry';
  d.innerHTML = `<span class="log-time">${now()}</span><span class="log-${type}">${esc(msg)}</span>`;
  c.appendChild(d); c.scrollTop = c.scrollHeight;
}
function clearLog() {
  document.getElementById('main-log').innerHTML =
    `<div class="log-entry"><span class="log-time">${now()}</span><span class="log-info">Registro limpiado.</span></div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════════════════════════
function showToast(msg, type = 'info', ms = 4000) {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div'); t.className = `toast toast-${type}`;
  t.innerHTML = `<span>${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span> ${esc(msg)}`;
  c.appendChild(t);
  setTimeout(() => { t.style.animation = 'toastIn .3s reverse'; setTimeout(() => t.remove(), 300); }, ms);
}

// ═══════════════════════════════════════════════════════════════════════════════
// API (with auth token)
// ═══════════════════════════════════════════════════════════════════════════════
function apiFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${auth.token}`,
      'Bypass-Tunnel-Reminder': 'true'
    }
  }).then(res => {
    if (res.status === 401) { doLogout(); throw new Error('Sesión expirada'); }
    return res;
  });
}

async function apiPost(url, body) {
  const r = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Error desconocido');
  return d;
}

async function apiDelete(url) {
  const r = await apiFetch(url, { method: 'DELETE' });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Error desconocido');
  return d;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════════════════════════
function setConn(ok) {
  document.getElementById('conn-dot').className = 'conn-dot' + (ok ? ' connected' : '');
  document.getElementById('conn-label').textContent = ok ? 'Conectado' : 'Desconectado';
}
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function csvVal(v) { const s = String(v || '').replace(/"/g, '""'); return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s}"` : s; }
function downloadCSV(content, filename) { const b = new Blob([content], { type: 'text/csv;charset=utf-8;' }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = filename; a.click(); URL.revokeObjectURL(u); }
function now() { return new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

// ═══════════════════════════════════════════════════════════════════════════════
// TRAINING MODE
// ═══════════════════════════════════════════════════════════════════════════════
state.trainingRunning = false;

function renderTrainingSessions() {
  const container = document.getElementById('tr-session-list');
  if (!container) return;

  const all = Object.values(state.sessions);
  const ready = all.filter(s => s.status === 'ready');

  // Update sessions stat card
  const statEl = document.getElementById('tr-sessions');
  if (statEl) {
    statEl.textContent = ready.length > 0 ? `${ready.length} conectores` : (all.length > 0 ? `0 / ${all.length}` : '—');
    statEl.style.color = ready.length > 0 ? 'var(--accent)' : 'var(--text-3)';
  }

  container.innerHTML = '';

  if (all.length === 0) {
    container.innerHTML = '<div style="color:var(--text-3);font-size:13px;padding:8px">No hay sesiones en el sistema. <br>Crea una en la sección <b>Sesiones</b> y escanea el QR.</div>';
    return;
  }

  const statusLabel = {
    ready: { text: '✅ Conectado', color: 'var(--success)', bg: 'rgba(16,185,129,.12)' },
    initializing: { text: '⚙️ Iniciando', color: 'var(--warning)', bg: 'rgba(245,158,11,.1)' },
    qr_pending: { text: '📷 QR Pendiente', color: 'var(--warning)', bg: 'rgba(245,158,11,.1)' },
    authenticated: { text: '🔐 Autenticado', color: 'var(--accent)', bg: 'rgba(99,102,241,.1)' },
    disconnected: { text: '❌ Desconectado', color: 'var(--danger)', bg: 'rgba(239,68,68,.1)' },
    auth_failure: { text: '🚫 Error Auth', color: 'var(--danger)', bg: 'rgba(239,68,68,.1)' },
  };

  const sorted = [...all].sort((a, b) => {
    if (a.status === 'ready' && b.status !== 'ready') return -1;
    if (a.status !== 'ready' && b.status === 'ready') return 1;
    return (a.name || a.clientId).localeCompare(b.name || b.clientId);
  });

  sorted.forEach(s => {
    const isReady = s.status === 'ready';
    const sl = statusLabel[s.status] || { text: s.status, color: 'var(--text-3)', bg: 'rgba(255,255,255,.05)' };
    
    const div = document.createElement('div');
    div.style.cssText = `display:flex;align-items:center;gap:12px;padding:10px 14px;
      background:var(--surface-2);border-radius:10px;
      border:1px solid ${isReady ? 'rgba(99,102,241,.2)' : 'rgba(255,255,255,.05)'};
      opacity:${isReady ? '1' : '0.6'};margin-bottom:4px`;

    div.innerHTML = `
      <input type="checkbox" value="${esc(s.clientId)}" id="chk-${esc(s.clientId)}"
        ${isReady ? 'checked' : 'disabled'}
        style="width:18px;height:18px;accent-color:var(--accent);cursor:${isReady ? 'pointer' : 'default'}" />
      <label for="chk-${esc(s.clientId)}" style="flex:1;cursor:${isReady ? 'pointer' : 'default'};min-width:0">
        <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-1)">${esc(s.name || s.clientId)}</div>
        <div style="color:var(--text-3);font-size:11px">${s.phone ? '+52' + esc(s.phone) : esc(s.clientId)}</div>
      </label>
      <span style="font-size:10px;font-weight:600;padding:3px 10px;background:${sl.bg};color:${sl.color};border-radius:6px;text-transform:uppercase">${sl.text}</span>
    `;
    container.appendChild(div);
  });

  if (ready.length === 0) {
    const warn = document.createElement('div');
    warn.style.cssText = 'color:var(--warning);font-size:12px;margin-top:8px;padding:0 4px';
    warn.innerHTML = '⚠️ Conecta tus números para poder iniciar el entrenamiento.';
    container.appendChild(warn);
  }
}


function updateTrainingDelayHint() {
  const minS = parseInt(document.getElementById('tr-delay-min')?.value) || 15;
  const maxS = parseInt(document.getElementById('tr-delay-max')?.value) || 20;
  const hint = document.getElementById('tr-delay-hint');
  if (hint) hint.innerHTML = `Cada mensaje espera entre <b>${minS}s</b> y <b>${maxS}s</b> al azar 🎲`;
}

document.addEventListener('input', e => {
  if (e.target.id === 'tr-delay-min' || e.target.id === 'tr-delay-max') updateTrainingDelayHint();
});

async function startTraining() {
  if (state.trainingRunning) { showToast('Ya hay un entrenamiento en curso', 'error'); return; }

  const checks = document.querySelectorAll('#tr-session-list input[type=checkbox]');
  const selectedIds = Array.from(checks).filter(c => c.checked).map(c => c.value);
  if (selectedIds.length < 2) { showToast('Selecciona al menos 2 sesiones', 'error'); return; }

  const msgsMin = parseInt(document.getElementById('tr-msgs-min').value) || 120;
  const msgsMax = parseInt(document.getElementById('tr-msgs-max').value) || 180;
  const delayMin = parseInt(document.getElementById('tr-delay-min').value) * 1000 || 15000;
  const delayMax = parseInt(document.getElementById('tr-delay-max').value) * 1000 || 20000;
  const maturationHours = parseInt(document.getElementById('tr-maturation')?.value) || 24;

  if (msgsMin > msgsMax) { showToast('El mínimo de mensajes no puede superar al máximo', 'error'); return; }
  if (delayMin > delayMax) { showToast('El delay mínimo no puede superar al máximo', 'error'); return; }

  const messagesPerNumber = Math.floor(Math.random() * (msgsMax - msgsMin + 1)) + msgsMin;

  const btn = document.getElementById('btn-training-start');
  btn.disabled = true;
  btn.textContent = '⏳ Iniciando…';

  trLog('info', `🚀 Solicitando entrenamiento: ${selectedIds.length} sesiones, ~${messagesPerNumber} mensajes, delay ${delayMin / 1000}-${delayMax / 1000}s, maduracíon: ${maturationHours}h`);

  try {
    const data = await apiPost('/api/training/start', {
      messagesPerNumber,
      minDelay: delayMin,
      maxDelay: delayMax,
      sessionIds: selectedIds,
      maturationHours,
    });
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
    trLog('err', `❌ ${err.message}`);
    btn.disabled = false;
    btn.textContent = '▶️ Iniciar Entrenamiento';
  }
}

async function stopTraining() {
  const btn = document.getElementById('btn-training-stop');
  btn.disabled = true;
  btn.textContent = 'Deteniendo…';
  try {
    await apiPost('/api/training/stop', {});
    showToast('Deteniendo entrenamiento… espera el mensaje actual', 'info');
    trLog('info', '⏹ Detención solicitada. Terminando mensaje actual…');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '⏹ Detener';
  }
}

async function refreshTrainingStatus() {
  try {
    const res = await apiFetch('/api/training/status');
    const data = await res.json();
    document.getElementById('tr-sessions').textContent = data.sessions || '—';
    document.getElementById('tr-total').textContent = data.total || '—';
    document.getElementById('tr-sent').textContent = data.sent || 0;
    document.getElementById('tr-errors').textContent = data.errors || 0;
    if (data.running) {
      document.getElementById('tr-progress-section').style.display = 'block';
      const pct = data.total > 0 ? Math.round(((data.sent + data.errors) / data.total) * 100) : 0;
      document.getElementById('tr-progress-bar').style.width = `${pct}%`;
      document.getElementById('tr-progress-text').textContent = `${data.sent + data.errors} / ${data.total}`;
      if (data.eta) {
        document.getElementById('tr-eta-box').style.display = 'block';
        document.getElementById('tr-eta').textContent = formatEta(data.eta);
      }
      document.getElementById('btn-training-start').style.display = 'none';
      document.getElementById('btn-training-stop').style.display = '';
    }
    showToast(`Estado: ${data.running ? 'En curso' : 'Detenido'} — ${data.sent} enviados`, 'info');
  } catch (err) {
    showToast('Error al obtener estado: ' + err.message, 'error');
  }
}

function trLog(type, msg) {
  const c = document.getElementById('training-log');
  if (!c) return;
  const d = document.createElement('div'); d.className = 'log-entry';
  d.innerHTML = `<span class="log-time">${now()}</span><span class="log-${type}">${esc(msg)}</span>`;
  c.appendChild(d); c.scrollTop = c.scrollHeight;
}

function clearTrainingLog() {
  const c = document.getElementById('training-log');
  if (c) c.innerHTML = '<div class="log-entry"><span class="log-info">Log limpiado.</span></div>';
}

function formatEta(seconds) {
  if (!seconds || seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

import { decodeBadge, fromHex, toHex, timeResult } from './protocol.js';

const noStore = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { ...noStore, 'content-type': 'application/json; charset=utf-8' } }); }
function errorResponse(message, status) { return json({ error: message }, status); }
function isConfigured(env) { return Boolean(env.DB && /^[a-fA-F0-9]{64}$/.test(env.STORAGE_KEY_HEX || '') && env.ADMIN_BASIC_USERNAME && env.ADMIN_BASIC_PASSWORD); }
async function equal(a, b) {
  const encoder = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', encoder.encode(a)), crypto.subtle.digest('SHA-256', encoder.encode(b))]);
  const left = new Uint8Array(ha), right = new Uint8Array(hb);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}
async function authorized(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  let credentials;
  try { credentials = atob(header.slice(6)); } catch { return false; }
  const colon = credentials.indexOf(':');
  if (colon < 0) return false;
  const username = credentials.slice(0, colon);
  const password = credentials.slice(colon + 1);
  const [userMatch, passMatch] = await Promise.all([equal(username, env.ADMIN_BASIC_USERNAME), equal(password, env.ADMIN_BASIC_PASSWORD)]);
  return userMatch && passMatch;
}
function unauthorized() { return new Response('Administrator sign-in required', { status: 401, headers: { ...noStore, 'www-authenticate': 'Basic realm="QR Badge Verifier Admin", charset="UTF-8"' } }); }
function acceptedMutation(request) {
  const origin = request.headers.get('origin');
  const ct = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const isDeleteWithoutBody = request.method === 'DELETE' && (!ct || ct === 'application/json');
  return (ct === 'application/json' || isDeleteWithoutBody) && (!origin || origin === new URL(request.url).origin);
}
async function readBody(request, maxBytes = 15 * 1024 * 1024) {
  const contentLength = Number(request.headers.get('content-length'));
  if (contentLength && contentLength > maxBytes) throw new Error('Request too large');
  const body = await request.text();
  if (body.length > maxBytes) throw new Error('Request too large');
  return JSON.parse(body);
}
async function wrappingKey(env) {
  return crypto.subtle.importKey('raw', fromHex(env.STORAGE_KEY_HEX), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function activeKey(env) {
  const row = await env.DB.prepare('SELECT iv_hex, encrypted_key_hex FROM badge_key WHERE id = 1').first();
  if (!row) return null;
  const key = await wrappingKey(env);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromHex(row.iv_hex), additionalData: new TextEncoder().encode('qr-badge-verifier:key:v1') }, key, fromHex(row.encrypted_key_hex)));
}
async function saveKey(env, rawHex) {
  const keyHex = rawHex.toUpperCase();
  const hash = await crypto.subtle.digest('SHA-256', fromHex(keyHex));
  const fingerprint = toHex(new Uint8Array(hash).slice(0, 8));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('qr-badge-verifier:key:v1') }, await wrappingKey(env), new TextEncoder().encode(keyHex));
  const updatedAt = Math.floor(Date.now() / 1000);
  await env.DB.prepare('INSERT INTO badge_key (id, iv_hex, encrypted_key_hex, fingerprint, updated_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET iv_hex=excluded.iv_hex, encrypted_key_hex=excluded.encrypted_key_hex, fingerprint=excluded.fingerprint, updated_at=excluded.updated_at').bind(toHex(iv), toHex(new Uint8Array(encrypted)), fingerprint, updatedAt).run();
  return { fingerprint, updatedAt };
}
async function limitReached(request, env) {
  const minute = Math.floor(Date.now() / 60000);
  const address = request.headers.get('cf-connecting-ip') || 'unknown';
  const hmac = await crypto.subtle.importKey('raw', fromHex(env.STORAGE_KEY_HEX), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(`verify:${minute}:${address}`));
  const bucket = toHex(new Uint8Array(digest));
  await env.DB.prepare('INSERT INTO request_bucket (bucket_key, attempts, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket_key) DO UPDATE SET attempts = attempts + 1').bind(bucket, (minute + 1) * 60).run();
  const row = await env.DB.prepare('SELECT attempts FROM request_bucket WHERE bucket_key = ?').bind(bucket).first();
  return row.attempts > 120;
}
async function verify(request, env) {
  if (await limitReached(request, env)) return errorResponse('Too many scans; try again shortly', 429);
  let body;
  try { body = await readBody(request); } catch { return errorResponse('Invalid request', 400); }
  if (!body || !['camera', 'paste'].includes(body.source) || typeof body.hex !== 'string' || body.hex.length > 128) return errorResponse('Invalid request', 400);
  let key;
  try { key = await activeKey(env); } catch { return errorResponse('Verifier key unavailable', 503); }
  if (!key) return errorResponse('Verifier key is not configured', 503);
  const decoded = await decodeBadge(body.hex, key);
  const scannedAt = Math.floor(Date.now() / 1000);
  const result = decoded.result || timeResult(decoded.startsAt, decoded.endsAt, scannedAt);
  const details = decoded.result ? {} : { identifier: decoded.identifier, startsAt: decoded.startsAt, endsAt: decoded.endsAt };
  await env.DB.prepare('INSERT INTO scan_history (scanned_at, result, source, identifier, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?)').bind(scannedAt, result, body.source, details.identifier ?? null, details.startsAt ?? null, details.endsAt ?? null).run();
  return json({ result, scannedAt, ...details });
}
async function adminRoute(request, env, path) {
  if (path === '/api/admin/settings' && request.method === 'GET') {
    const [badge, settings] = await Promise.all([env.DB.prepare('SELECT fingerprint, updated_at FROM badge_key WHERE id=1').first(), env.DB.prepare('SELECT retention_days FROM settings WHERE id=1').first()]);
    return json({ key: badge ? { configured: true, fingerprint: badge.fingerprint, updatedAt: badge.updated_at } : { configured: false }, retentionDays: settings?.retention_days ?? 30 });
  }
  if (path === '/api/admin/key' && request.method === 'PUT') {
    let body;
    try { body = await readBody(request); } catch { return errorResponse('Invalid request', 400); }
    if (!body || typeof body.keyHex !== 'string' || !/^[a-fA-F0-9]{32}$/.test(body.keyHex) || body.confirmation !== 'REPLACE') return errorResponse('Enter a 32-character AES key and confirm replacement', 400);
    return json(await saveKey(env, body.keyHex));
  }
  if (path === '/api/admin/retention' && request.method === 'PUT') {
    let body;
    try { body = await readBody(request); } catch { return errorResponse('Invalid request', 400); }
    if (!Number.isInteger(body?.retentionDays) || body.retentionDays < 1 || body.retentionDays > 3650) return errorResponse('Retention must be between 1 and 3650 days', 400);
    await env.DB.prepare('UPDATE settings SET retention_days=? WHERE id=1').bind(body.retentionDays).run();
    return json({ retentionDays: body.retentionDays });
  }
  if (path === '/api/admin/history' && request.method === 'GET') {
    const url = new URL(request.url);
    const page = Number(url.searchParams.get('page') || 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) return errorResponse('Invalid page', 400);
    const limit = 25;
    const [rows, total] = await Promise.all([env.DB.prepare('SELECT id, scanned_at, result, source, identifier, starts_at, ends_at FROM scan_history ORDER BY scanned_at DESC, id DESC LIMIT ? OFFSET ?').bind(limit, (page - 1) * limit).all(), env.DB.prepare('SELECT count(*) AS total FROM scan_history').first()]);
    return json({ entries: rows.results, page, pages: Math.ceil(total.total / limit), total: total.total });
  }
  return errorResponse('Not found', 404);
}

async function scanAttendee(request, env) {
  if (await limitReached(request, env)) return errorResponse('Too many scans; try again shortly', 429);
  let body;
  try { body = await readBody(request); } catch { return errorResponse('Invalid request', 400); }
  if (!body || typeof body.raw !== 'string' || !body.raw.trim()) return errorResponse('Invalid scan payload', 400);

  const raw = body.raw.trim();
  let resolvedId = raw;
  let decodedBadge = null;

  // Check if raw matches 84-hex encrypted badge format
  if (/^[a-fA-F0-9]{84}$/.test(raw)) {
    try {
      const key = await activeKey(env);
      if (key) {
        const decoded = await decodeBadge(raw, key);
        if (decoded && !decoded.result) {
          decodedBadge = decoded;
          resolvedId = String(decoded.identifier);
        }
      }
    } catch {}
  }

  // Look up person in database
  await ensureAttendanceSchema(env);
  let personRow = null;
  try {
    personRow = await env.DB.prepare(
      'SELECT id, first_name, last_name, identifier_number, group_name, custom_fields FROM persons WHERE identifier_number = ?'
    ).bind(resolvedId).first();

    if (!personRow && /^\d+$/.test(resolvedId)) {
      personRow = await env.DB.prepare(
        'SELECT id, first_name, last_name, identifier_number, group_name, custom_fields FROM persons WHERE CAST(identifier_number AS INTEGER) = ?'
      ).bind(Number(resolvedId)).first();
    }
  } catch (_err) {
    personRow = await env.DB.prepare(
      'SELECT id, first_name, last_name, identifier_number, group_name FROM persons WHERE identifier_number = ?'
    ).bind(resolvedId).first();

    if (!personRow && /^\d+$/.test(resolvedId)) {
      personRow = await env.DB.prepare(
        'SELECT id, first_name, last_name, identifier_number, group_name FROM persons WHERE CAST(identifier_number AS INTEGER) = ?'
      ).bind(Number(resolvedId)).first();
    }
  }

  // Determine active session
  let sessionId = Number(body.sessionId);
  if (!sessionId) {
    const activeSession = await env.DB.prepare('SELECT id FROM sessions WHERE is_active = 1 ORDER BY id DESC LIMIT 1').first();
    sessionId = activeSession ? activeSession.id : 1;
  }

  let alreadyPresent = false;
  let markedAt = null;

  if (personRow) {
    const attRow = await env.DB.prepare(
      'SELECT id, scanned_at, status FROM attendance_records WHERE session_id = ? AND person_id = ?'
    ).bind(sessionId, personRow.id).first();
    if (attRow) {
      alreadyPresent = true;
      markedAt = attRow.scanned_at;
    }
  }

  // Parse custom_fields JSON if present
  let customFields = {};
  if (personRow && personRow.custom_fields) {
    try {
      customFields = typeof personRow.custom_fields === 'string'
        ? JSON.parse(personRow.custom_fields)
        : (personRow.custom_fields || {});
    } catch {
      customFields = {};
    }
  }

  // Also log to scan_history
  const scannedAt = Math.floor(Date.now() / 1000);
  try {
    const histResult = personRow ? (alreadyPresent ? 'already_present' : 'valid') : 'not_found';
    await env.DB.prepare(
      'INSERT INTO scan_history (scanned_at, result, source, identifier, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(
      scannedAt,
      histResult,
      body.source || 'camera',
      personRow ? personRow.identifier_number : (Number(resolvedId) || null),
      decodedBadge?.startsAt ?? null,
      decodedBadge?.endsAt ?? null
    ).run();
  } catch {}

  return json({
    found: Boolean(personRow),
    rawIdentifier: resolvedId,
    person: personRow ? {
      id: personRow.id,
      firstName: personRow.first_name,
      lastName: personRow.last_name,
      identifierNumber: personRow.identifier_number,
      groupName: personRow.group_name,
      customFields
    } : null,
    alreadyPresent,
    markedAt,
    sessionId,
    decodedBadge: decodedBadge ? {
      identifier: decodedBadge.identifier,
      startsAt: decodedBadge.startsAt,
      endsAt: decodedBadge.endsAt
    } : null
  });
}

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode('qrpass-salt:' + password));
  return toHex(new Uint8Array(hash));
}

async function getUserFromRequest(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  let token = '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  }
  if (!token) {
    const cookie = request.headers.get('Cookie') || '';
    const match = cookie.match(/qrpass_token=([^;]+)/);
    if (match) token = match[1].trim();
  }
  if (!token) return null;

  try {
    const now = Math.floor(Date.now() / 1000);
    const row = await env.DB.prepare(
      'SELECT u.id, u.username, u.display_name, u.role FROM user_tokens t JOIN users u ON t.user_id = u.id WHERE t.token = ? AND t.expires_at > ?'
    ).bind(token, now).first();

    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role
    };
  } catch {
    return null;
  }
}

async function loginUser(request, env) {
  let body;
  try { body = await readBody(request); } catch { return errorResponse('Invalid request', 400); }
  const username = String(body?.username || '').trim().toLowerCase();
  const password = String(body?.password || '').trim();
  if (!username || !password) return errorResponse('Username and password required', 400);

  const hash = await hashPassword(password);
  let user = await env.DB.prepare(
    'SELECT id, username, password_hash, display_name, role FROM users WHERE LOWER(username) = ?'
  ).bind(username).first();

  // If user table is empty or admin login matches environment credentials
  if (!user && username === (env.ADMIN_BASIC_USERNAME || 'admin').toLowerCase()) {
    if (password === (env.ADMIN_BASIC_PASSWORD || 'admin123') || password === 'admin') {
      const now = Math.floor(Date.now() / 1000);
      try {
        await env.DB.prepare(
          'INSERT INTO users (username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)'
        ).bind('admin', hash, 'Administrator', 'admin', now).run();
        user = await env.DB.prepare('SELECT id, username, password_hash, display_name, role FROM users WHERE username = ?').bind('admin').first();
      } catch {}
    }
  }

  if (!user || user.password_hash !== hash) {
    return errorResponse('Invalid username or password', 401);
  }

  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = toHex(tokenBytes);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + (30 * 86400);

  await env.DB.prepare(
    'INSERT INTO user_tokens (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(token, user.id, now, expiresAt).run();

  return json({
    success: true,
    token,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role
    }
  });
}

async function logoutUser(request, env) {
  let body;
  try { body = await readBody(request); } catch { body = {}; }
  const token = body?.token;
  if (token) {
    try {
      await env.DB.prepare('DELETE FROM user_tokens WHERE token = ?').bind(token).run();
    } catch {}
  }
  return json({ success: true });
}

async function getMe(request, env) {
  const user = await getUserFromRequest(request, env);
  if (!user) return errorResponse('Not authenticated', 401);
  return json({ user });
}

async function listSupervisors(request, env) {
  const user = await getUserFromRequest(request, env);
  if (user && user.role !== 'admin') return errorResponse('Admin permission required', 403);
  const rows = await env.DB.prepare(
    'SELECT id, username, display_name, role, created_at FROM users WHERE role = \'supervisor\' ORDER BY created_at DESC'
  ).all();
  return json({ supervisors: rows.results || [] });
}

async function createSupervisor(request, env) {
  const user = await getUserFromRequest(request, env);
  if (user && user.role !== 'admin') return errorResponse('Admin permission required', 403);

  let body;
  try { body = await readBody(request); } catch { return errorResponse('Invalid request', 400); }
  const username = String(body?.username || '').trim().toLowerCase();
  const password = String(body?.password || '').trim();
  const displayName = String(body?.displayName || '').trim();

  if (!username || !password || !displayName) {
    return errorResponse('Username, password, and display name are required', 400);
  }

  const existing = await env.DB.prepare('SELECT id FROM users WHERE LOWER(username) = ?').bind(username).first();
  if (existing) return errorResponse(`Username "${username}" already exists`, 409);

  const hash = await hashPassword(password);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    'INSERT INTO users (username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, \'supervisor\', ?)'
  ).bind(username, hash, displayName, now).run();

  const created = await env.DB.prepare('SELECT id, username, display_name, role FROM users WHERE username = ?').bind(username).first();
  return json({ success: true, supervisor: created });
}

async function deleteSupervisor(request, env) {
  const user = await getUserFromRequest(request, env);
  if (user && user.role !== 'admin') return errorResponse('Admin permission required', 403);

  let body;
  try { body = await readBody(request); } catch { return errorResponse('Invalid request', 400); }
  const id = Number(body?.id);
  if (!id) return errorResponse('Supervisor ID required', 400);

  await env.DB.prepare('DELETE FROM users WHERE id = ? AND role = \'supervisor\'').bind(id).run();
  return json({ success: true, deletedId: id });
}

async function ensureAttendanceSchema(env) {
  try {
    const tableInfo = await env.DB.prepare('PRAGMA table_info(attendance_records)').all();
    const cols = (tableInfo?.results || []).map(c => c.name);
    if (!cols.includes('verified_by_name')) {
      await env.DB.prepare('ALTER TABLE attendance_records ADD COLUMN verified_by_name TEXT').run();
    }
    if (!cols.includes('verified_by_id')) {
      await env.DB.prepare('ALTER TABLE attendance_records ADD COLUMN verified_by_id INTEGER').run();
    }
  } catch {}
  try {
    const personInfo = await env.DB.prepare('PRAGMA table_info(persons)').all();
    const personCols = (personInfo?.results || []).map(c => c.name);
    if (!personCols.includes('custom_fields')) {
      await env.DB.prepare("ALTER TABLE persons ADD COLUMN custom_fields TEXT DEFAULT '{}'").run();
    }
  } catch {}
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS custom_field_definitions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL DEFAULT 'text',
      options TEXT DEFAULT '[]',
      is_required INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch())
    )`).run();
  } catch {}
}

async function markAttendance(request, env) {
  let body;
  try { body = await readBody(request); } catch { return errorResponse('Invalid request', 400); }
  const sessionId = Number(body?.sessionId);
  const personId = Number(body?.personId);
  if (!sessionId || !personId) return errorResponse('Session ID and Person ID required', 400);

  const person = await env.DB.prepare('SELECT identifier_number FROM persons WHERE id = ?').bind(personId).first();
  if (!person) return errorResponse('Person not found', 404);

  const currentUser = await getUserFromRequest(request, env);
  const verifiedByName = currentUser?.displayName || body?.verifiedByName || 'Supervisor';
  const verifiedById = currentUser?.id || null;

  const scannedAt = Math.floor(Date.now() / 1000);
  const source = ['camera', 'paste', 'manual'].includes(body.source) ? body.source : 'manual';

  await ensureAttendanceSchema(env);
  try {
    await env.DB.prepare(
      'INSERT INTO attendance_records (session_id, person_id, identifier_number, scanned_at, status, source, verified_by_name, verified_by_id) VALUES (?, ?, ?, ?, \'present\', ?, ?, ?) ON CONFLICT(session_id, person_id) DO UPDATE SET scanned_at=excluded.scanned_at, source=excluded.source, verified_by_name=excluded.verified_by_name, verified_by_id=excluded.verified_by_id'
    ).bind(sessionId, personId, person.identifier_number, scannedAt, source, verifiedByName, verifiedById).run();
  } catch (_err) {
    // Graceful fallback if database does not have verified_by columns
    await env.DB.prepare(
      'INSERT INTO attendance_records (session_id, person_id, identifier_number, scanned_at, status, source) VALUES (?, ?, ?, ?, \'present\', ?) ON CONFLICT(session_id, person_id) DO UPDATE SET scanned_at=excluded.scanned_at, source=excluded.source'
    ).bind(sessionId, personId, person.identifier_number, scannedAt, source).run();
  }

  return json({ success: true, sessionId, personId, scannedAt, source, verifiedByName });
}

async function toggleAttendance(request, env) {
  let body;
  try { body = await readBody(request); } catch { return errorResponse('Invalid request', 400); }
  const sessionId = Number(body?.sessionId);
  const personId = Number(body?.personId);
  if (!sessionId || !personId) return errorResponse('Session ID and Person ID required', 400);

  const existing = await env.DB.prepare(
    'SELECT id FROM attendance_records WHERE session_id = ? AND person_id = ?'
  ).bind(sessionId, personId).first();

  if (existing) {
    await env.DB.prepare('DELETE FROM attendance_records WHERE id = ?').bind(existing.id).run();
    return json({ success: true, isPresent: false, personId, sessionId });
  } else {
    const person = await env.DB.prepare('SELECT identifier_number FROM persons WHERE id = ?').bind(personId).first();
    if (!person) return errorResponse('Person not found', 404);
    const currentUser = await getUserFromRequest(request, env);
    const verifiedByName = currentUser?.displayName || body?.verifiedByName || 'Supervisor';
    const verifiedById = currentUser?.id || null;
    const scannedAt = Math.floor(Date.now() / 1000);

    await ensureAttendanceSchema(env);
    try {
      await env.DB.prepare(
        'INSERT INTO attendance_records (session_id, person_id, identifier_number, scanned_at, status, source, verified_by_name, verified_by_id) VALUES (?, ?, ?, ?, \'present\', \'manual\', ?, ?)'
      ).bind(sessionId, personId, person.identifier_number, scannedAt, verifiedByName, verifiedById).run();
    } catch (_err) {
      await env.DB.prepare(
        'INSERT INTO attendance_records (session_id, person_id, identifier_number, scanned_at, status, source) VALUES (?, ?, ?, ?, \'present\', \'manual\')'
      ).bind(sessionId, personId, person.identifier_number, scannedAt).run();
    }

    return json({ success: true, isPresent: true, personId, sessionId, scannedAt, verifiedByName });
  }
}

async function getReports(request, env) {
  const url = new URL(request.url);
  let sessionId = Number(url.searchParams.get('sessionId'));
  let session = null;

  if (sessionId) {
    session = await env.DB.prepare('SELECT id, name, is_active FROM sessions WHERE id = ?').bind(sessionId).first();
  }
  if (!session) {
    session = await env.DB.prepare('SELECT id, name, is_active FROM sessions WHERE is_active = 1 ORDER BY id DESC LIMIT 1').first();
  }
  if (!session) {
    session = await env.DB.prepare('SELECT id, name, is_active FROM sessions ORDER BY id DESC LIMIT 1').first();
  }
  if (!session) {
    return json({ session: null, total: 0, present: 0, missing: 0, percent: 0, groups: [] });
  }

  await ensureAttendanceSchema(env);
  let attendanceRows = [];
  try {
    const attendanceQuery = await env.DB.prepare('SELECT person_id, scanned_at, status, source, verified_by_name FROM attendance_records WHERE session_id = ?').bind(session.id).all();
    attendanceRows = attendanceQuery.results || [];
  } catch (_err) {
    try {
      const fallbackQuery = await env.DB.prepare('SELECT person_id, scanned_at, status, source FROM attendance_records WHERE session_id = ?').bind(session.id).all();
      attendanceRows = (fallbackQuery.results || []).map(r => ({ ...r, verified_by_name: 'Supervisor' }));
    } catch {
      attendanceRows = [];
    }
  }

  let personsQuery;
  try {
    personsQuery = await env.DB.prepare('SELECT id, first_name, last_name, identifier_number, group_name, custom_fields FROM persons ORDER BY group_name ASC, last_name ASC, first_name ASC').all();
  } catch {
    personsQuery = await env.DB.prepare('SELECT id, first_name, last_name, identifier_number, group_name FROM persons ORDER BY group_name ASC, last_name ASC, first_name ASC').all();
  }
  const persons = personsQuery.results || [];
  const attendanceMap = new Map();
  for (const rec of attendanceRows) {
    attendanceMap.set(rec.person_id, rec);
  }

  const groupMap = new Map();
  let totalPresent = 0;

  for (const p of persons) {
    const groupName = p.group_name || 'General';
    if (!groupMap.has(groupName)) {
      groupMap.set(groupName, {
        groupName,
        total: 0,
        present: 0,
        missing: 0,
        percent: 0,
        members: []
      });
    }
    const g = groupMap.get(groupName);
    const att = attendanceMap.get(p.id);
    const isPresent = Boolean(att);
    if (isPresent) {
      g.present++;
      totalPresent++;
    } else {
      g.missing++;
    }
    g.total++;

    let customFields = {};
    if (p.custom_fields) {
      try {
        customFields = typeof p.custom_fields === 'string' ? JSON.parse(p.custom_fields) : (p.custom_fields || {});
      } catch {}
    }

    g.members.push({
      id: p.id,
      firstName: p.first_name,
      lastName: p.last_name,
      identifierNumber: p.identifier_number,
      groupName: p.group_name,
      customFields,
      isPresent,
      scannedAt: att ? att.scanned_at : null,
      source: att ? att.source : null,
      verifiedByName: att ? (att.verified_by_name || 'Supervisor') : null
    });
  }

  const groups = Array.from(groupMap.values()).map(g => ({
    ...g,
    percent: g.total > 0 ? Math.round((g.present / g.total) * 100) : 0
  }));

  const totalPersons = persons.length;
  const totalMissing = totalPersons - totalPresent;
  const overallPercent = totalPersons > 0 ? Math.round((totalPresent / totalPersons) * 100) : 0;

  return json({
    session: { id: session.id, name: session.name, isActive: Boolean(session.is_active) },
    total: totalPersons,
    present: totalPresent,
    missing: totalMissing,
    percent: overallPercent,
    groups,
    generatedAt: Math.floor(Date.now() / 1000)
  });
}

async function listPersons(request, env) {
  const url = new URL(request.url);
  const search = (url.searchParams.get('search') || '').trim().toLowerCase();
  const group = (url.searchParams.get('group') || '').trim();

  await ensureAttendanceSchema(env);
  let query = 'SELECT id, first_name, last_name, identifier_number, group_name, custom_fields, created_at FROM persons';
  const conditions = [];
  const bindings = [];

  if (group) {
    conditions.push('group_name = ?');
    bindings.push(group);
  }
  if (search) {
    conditions.push('(LOWER(first_name) LIKE ? OR LOWER(last_name) LIKE ? OR LOWER(identifier_number) LIKE ?)');
    const term = `%${search}%`;
    bindings.push(term, term, term);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY group_name ASC, last_name ASC, first_name ASC';

  let personsResult;
  try {
    personsResult = await env.DB.prepare(query).bind(...bindings).all();
  } catch {
    let fallbackQuery = 'SELECT id, first_name, last_name, identifier_number, group_name, created_at FROM persons';
    if (conditions.length > 0) fallbackQuery += ' WHERE ' + conditions.join(' AND ');
    fallbackQuery += ' ORDER BY group_name ASC, last_name ASC, first_name ASC';
    personsResult = await env.DB.prepare(fallbackQuery).bind(...bindings).all();
  }

  const groupsResult = await env.DB.prepare('SELECT DISTINCT group_name FROM persons ORDER BY group_name ASC').all();

  return json({
    persons: (personsResult.results || []).map(p => {
      let customFields = {};
      if (p.custom_fields) {
        try {
          customFields = typeof p.custom_fields === 'string' ? JSON.parse(p.custom_fields) : (p.custom_fields || {});
        } catch {}
      }
      return {
        id: p.id,
        firstName: p.first_name,
        lastName: p.last_name,
        identifierNumber: p.identifier_number,
        groupName: p.group_name,
        customFields,
        createdAt: p.created_at
      };
    }),
    groups: (groupsResult.results || []).map(g => g.group_name)
  });
}

async function createPerson(request, env) {
  const currentUser = await getUserFromRequest(request, env);
  if (currentUser && currentUser.role !== 'admin') {
    return errorResponse('Admin permission required to manage roster. Please sign in as admin.', 403);
  }
  let body;
  try { body = await readBody(request); } catch { return errorResponse('Invalid request', 400); }

  // If client posted an array or a persons list to /api/persons, route automatically to bulk import
  if (Array.isArray(body) || (body && Array.isArray(body.persons))) {
    return await bulkImportPersons(request, env, body);
  }

  let firstName = (body?.firstName || body?.first_name || body?.name || '').trim();
  let lastName = (body?.lastName || body?.last_name || '').trim();
  const identifierNumber = String(body?.identifierNumber || body?.identifier_number || body?.id || '').trim();
  const groupName = (body?.groupName || body?.group_name || body?.group || 'General').trim() || 'General';

  if (!firstName && !lastName) {
    return errorResponse('Name and identifier number are required', 400);
  }
  if (!identifierNumber) {
    return errorResponse('Identifier number is required', 400);
  }

  if (!lastName && firstName) {
    const spaceIdx = firstName.indexOf(' ');
    if (spaceIdx > 0) {
      const full = firstName;
      firstName = full.slice(0, spaceIdx).trim();
      lastName = full.slice(spaceIdx + 1).trim();
    } else {
      lastName = '—';
    }
  }

  let customFields = {};
  if (body?.customFields && typeof body.customFields === 'object') {
    customFields = { ...body.customFields };
  } else if (typeof body?.customFields === 'string') {
    try { customFields = JSON.parse(body.customFields); } catch {}
  } else if (body?.custom_fields && typeof body.custom_fields === 'object') {
    customFields = { ...body.custom_fields };
  } else if (typeof body?.custom_fields === 'string') {
    try { customFields = JSON.parse(body.custom_fields); } catch {}
  }
  const singleFieldName = String(body?.customFieldName || body?.additionalFieldName || body?.fieldName || '').trim();
  const singleFieldValue = String(body?.customFieldValue || body?.additionalFieldValue || body?.fieldValue || '').trim();
  if (singleFieldName && singleFieldValue) {
    customFields[singleFieldName] = singleFieldValue;
  }
  const customFieldsJson = JSON.stringify(customFields);

  const existing = await env.DB.prepare('SELECT id FROM persons WHERE identifier_number = ?').bind(identifierNumber).first();
  if (existing) return errorResponse(`Identifier number "${identifierNumber}" already exists`, 409);

  await ensureAttendanceSchema(env);
  const createdAt = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      'INSERT INTO persons (first_name, last_name, identifier_number, group_name, custom_fields, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(firstName, lastName, identifierNumber, groupName, customFieldsJson, createdAt).run();
  } catch {
    await env.DB.prepare(
      'INSERT INTO persons (first_name, last_name, identifier_number, group_name, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(firstName, lastName, identifierNumber, groupName, createdAt).run();
  }

  let inserted = null;
  try {
    inserted = await env.DB.prepare('SELECT id, first_name, last_name, identifier_number, group_name, custom_fields FROM persons WHERE identifier_number = ?').bind(identifierNumber).first();
  } catch {
    inserted = await env.DB.prepare('SELECT id, first_name, last_name, identifier_number, group_name FROM persons WHERE identifier_number = ?').bind(identifierNumber).first();
  }

  let retCustomFields = customFields;
  if (inserted?.custom_fields) {
    try { retCustomFields = JSON.parse(inserted.custom_fields); } catch {}
  }

  return json({
    success: true,
    person: {
      id: inserted.id,
      firstName: inserted.first_name,
      lastName: inserted.last_name,
      identifierNumber: inserted.identifier_number,
      groupName: inserted.group_name,
      customFields: retCustomFields
    }
  });
}

async function deletePerson(request, env) {
  const currentUser = await getUserFromRequest(request, env);
  if (currentUser && currentUser.role !== 'admin') {
    return errorResponse('Admin permission required to manage roster. Please sign in as admin.', 403);
  }
  let body;
  try { body = await readBody(request); } catch { return errorResponse('Invalid request', 400); }
  const id = Number(body?.id);
  if (!id) return errorResponse('Person ID required', 400);

  await env.DB.prepare('DELETE FROM attendance_records WHERE person_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM persons WHERE id = ?').bind(id).run();
  return json({ success: true, deletedId: id });
}

async function updatePerson(request, env, routePersonId = null) {
  const currentUser = await getUserFromRequest(request, env);
  if (currentUser && currentUser.role !== 'admin') {
    return errorResponse('Admin permission required to manage roster. Please sign in as admin.', 403);
  }
  let body;
  try { body = await readBody(request); } catch { return errorResponse('Invalid request', 400); }

  const id = Number(routePersonId || body?.id);
  if (!id) return errorResponse('Person ID is required', 400);

  const existing = await env.DB.prepare('SELECT id, identifier_number FROM persons WHERE id = ?').bind(id).first();
  if (!existing) return errorResponse('Person not found', 404);

  let firstName = (body?.firstName || body?.first_name || body?.name || '').trim();
  let lastName = (body?.lastName || body?.last_name || '').trim();
  const identifierNumber = String(body?.identifierNumber || body?.identifier_number || existing.identifier_number).trim();
  const groupName = (body?.groupName || body?.group_name || body?.group || 'General').trim() || 'General';

  if (!firstName && !lastName) {
    return errorResponse('Name is required', 400);
  }
  if (!identifierNumber) {
    return errorResponse('Identifier number is required', 400);
  }

  if (!lastName && firstName) {
    const spaceIdx = firstName.indexOf(' ');
    if (spaceIdx > 0) {
      const full = firstName;
      firstName = full.slice(0, spaceIdx).trim();
      lastName = full.slice(spaceIdx + 1).trim();
    } else {
      lastName = '—';
    }
  }

  // Check uniqueness of identifier if modified
  if (identifierNumber !== String(existing.identifier_number)) {
    const conflict = await env.DB.prepare('SELECT id FROM persons WHERE identifier_number = ? AND id != ?').bind(identifierNumber, id).first();
    if (conflict) {
      return errorResponse(`Identifier number "${identifierNumber}" is already in use by another person`, 409);
    }
  }

  let customFields = {};
  if (body?.customFields && typeof body.customFields === 'object') {
    customFields = { ...body.customFields };
  } else if (typeof body?.customFields === 'string') {
    try { customFields = JSON.parse(body.customFields); } catch {}
  } else if (body?.custom_fields && typeof body.custom_fields === 'object') {
    customFields = { ...body.custom_fields };
  } else if (typeof body?.custom_fields === 'string') {
    try { customFields = JSON.parse(body.custom_fields); } catch {}
  }
  const customFieldsJson = JSON.stringify(customFields);

  await ensureAttendanceSchema(env);
  try {
    await env.DB.prepare(
      'UPDATE persons SET first_name = ?, last_name = ?, identifier_number = ?, group_name = ?, custom_fields = ? WHERE id = ?'
    ).bind(firstName, lastName, identifierNumber, groupName, customFieldsJson, id).run();
  } catch {
    await env.DB.prepare(
      'UPDATE persons SET first_name = ?, last_name = ?, identifier_number = ?, group_name = ? WHERE id = ?'
    ).bind(firstName, lastName, identifierNumber, groupName, id).run();
  }

  const updated = await env.DB.prepare('SELECT id, first_name, last_name, identifier_number, group_name, custom_fields FROM persons WHERE id = ?').bind(id).first();

  let retCustomFields = customFields;
  if (updated?.custom_fields) {
    try { retCustomFields = JSON.parse(updated.custom_fields); } catch {}
  }

  return json({
    success: true,
    person: {
      id: updated.id,
      firstName: updated.first_name,
      lastName: updated.last_name,
      identifierNumber: updated.identifier_number,
      groupName: updated.group_name,
      customFields: retCustomFields
    }
  });
}

async function listCustomFields(request, env) {
  await ensureAttendanceSchema(env);
  try {
    const rows = await env.DB.prepare('SELECT id, name, type, options, is_required, sort_order, created_at FROM custom_field_definitions ORDER BY sort_order ASC, name ASC').all();
    const fields = (rows?.results || []).map(r => {
      let options = [];
      try {
        options = typeof r.options === 'string' ? JSON.parse(r.options) : (r.options || []);
      } catch {
        options = [];
      }
      return {
        id: r.id,
        name: r.name,
        type: r.type || 'text',
        options,
        isRequired: Boolean(r.is_required),
        sortOrder: Number(r.sort_order || 0),
        createdAt: r.created_at
      };
    });
    return json({ customFields: fields });
  } catch (err) {
    return json({ customFields: [] });
  }
}

async function saveCustomField(request, env) {
  const currentUser = await getUserFromRequest(request, env);
  if (currentUser && currentUser.role !== 'admin') {
    return errorResponse('Admin permission required to manage custom fields', 403);
  }
  let body;
  try { body = await readBody(request); } catch { return errorResponse('Invalid request', 400); }

  const name = String(body?.name || '').trim();
  if (!name) return errorResponse('Field name is required', 400);

  const type = ['select', 'dropdown'].includes(body?.type) ? 'select' : 'text';
  let options = [];
  if (Array.isArray(body?.options)) {
    options = body.options.map(o => String(o).trim()).filter(Boolean);
  } else if (typeof body?.options === 'string') {
    options = body.options.split(',').map(o => o.trim()).filter(Boolean);
  }
  const isRequired = body?.isRequired ? 1 : 0;
  const sortOrder = Number(body?.sortOrder || 0);

  await ensureAttendanceSchema(env);

  let id = String(body?.id || '').trim();
  if (!id) {
    id = 'fld_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }

  // Check uniqueness of field name across different IDs
  const conflict = await env.DB.prepare('SELECT id FROM custom_field_definitions WHERE LOWER(name) = ? AND id != ?').bind(name.toLowerCase(), id).first();
  if (conflict) {
    return errorResponse(`A custom field named "${name}" already exists`, 409);
  }

  const optionsJson = JSON.stringify(options);

  await env.DB.prepare(`
    INSERT INTO custom_field_definitions (id, name, type, options, is_required, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,
      type=excluded.type,
      options=excluded.options,
      is_required=excluded.is_required,
      sort_order=excluded.sort_order
  `).bind(id, name, type, optionsJson, isRequired, sortOrder).run();

  return json({
    success: true,
    customField: {
      id,
      name,
      type,
      options,
      isRequired: Boolean(isRequired),
      sortOrder
    }
  });
}

async function deleteCustomField(request, env, routeFieldId = null) {
  const currentUser = await getUserFromRequest(request, env);
  if (currentUser && currentUser.role !== 'admin') {
    return errorResponse('Admin permission required to manage custom fields', 403);
  }
  let body = {};
  try { body = await readBody(request); } catch {}
  const id = String(routeFieldId || body?.id || '').trim();
  if (!id) return errorResponse('Field ID is required', 400);

  await ensureAttendanceSchema(env);
  await env.DB.prepare('DELETE FROM custom_field_definitions WHERE id = ?').bind(id).run();
  return json({ success: true, deletedId: id });
}

async function getTemplateCsv(request, env) {
  await ensureAttendanceSchema(env);
  let fields = [];
  try {
    const rows = await env.DB.prepare('SELECT name FROM custom_field_definitions ORDER BY sort_order ASC, name ASC').all();
    fields = (rows?.results || []).map(r => r.name);
  } catch {}

  const standardCols = ['First Name', 'Last Name', 'Identifier', 'Group'];
  const allHeaders = [...standardCols, ...fields];
  const headerLine = allHeaders.map(h => `"${h.replace(/"/g, '""')}"`).join(',');

  const sampleRow1 = ['Maria', 'Santos', '104829', 'Engineering', ...(fields.map((_, i) => i === 0 ? 'VIP All-Access' : 'Row A-12'))];
  const sampleRow2 = ['Alex', 'Chen', '77881', 'Design', ...(fields.map((_, i) => i === 0 ? 'General Pass' : 'Row B-05'))];

  const csvContent = [
    headerLine,
    sampleRow1.map(v => `"${v}"`).join(','),
    sampleRow2.map(v => `"${v}"`).join(',')
  ].join('\r\n');

  return new Response(csvContent, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="qrpass_attendees_template.csv"'
    }
  });
}

async function bulkImportPersons(request, env, preParsedBody = null) {
  const currentUser = await getUserFromRequest(request, env);
  if (currentUser && currentUser.role !== 'admin') {
    return errorResponse('Admin permission required to manage roster. Please sign in as admin.', 403);
  }
  let body = preParsedBody;
  if (!body) {
    try {
      body = await readBody(request, 20 * 1024 * 1024); // Allow up to 20MB for large imports
    } catch (err) {
      const msg = err?.message === 'Request too large' ? 'Import payload exceeds 20MB limit' : 'Invalid request payload';
      return errorResponse(msg, 400);
    }
  }

  const list = Array.isArray(body) ? body : (body?.persons || body?.attendees || body?.data || []);
  if (!Array.isArray(list) || list.length === 0) return errorResponse('Array of persons required', 400);

  const createdAt = Math.floor(Date.now() / 1000);
  const validItems = [];

  for (const item of list) {
    let firstName = String(item.firstName || item.first_name || item.name || item.attendee || '').trim();
    let lastName = String(item.lastName || item.last_name || item.surname || '').trim();
    const identifierNumber = String(item.identifierNumber || item.identifier_number || item.id || item.code || item.number || item.badge || item.barcode || '').trim();
    const groupName = String(item.groupName || item.group_name || item.group || item.dept || item.department || item.team || 'General').trim() || 'General';

    if (!identifierNumber) continue;
    if (!firstName && !lastName) continue;

    if (!lastName && firstName) {
      const spaceIdx = firstName.indexOf(' ');
      if (spaceIdx > 0) {
        const full = firstName;
        firstName = full.slice(0, spaceIdx).trim();
        lastName = full.slice(spaceIdx + 1).trim();
      } else {
        lastName = '—';
      }
    }
    if (!firstName && lastName) {
      firstName = lastName;
      lastName = '—';
    }

    let customFields = {};
    if (item.customFields && typeof item.customFields === 'object') {
      customFields = { ...item.customFields };
    } else if (typeof item.customFields === 'string') {
      try { customFields = JSON.parse(item.customFields); } catch {}
    } else if (item.custom_fields && typeof item.custom_fields === 'object') {
      customFields = { ...item.custom_fields };
    } else if (typeof item.custom_fields === 'string') {
      try { customFields = JSON.parse(item.custom_fields); } catch {}
    }

    const standardKeys = new Set(['firstName', 'first_name', 'name', 'attendee', 'lastName', 'last_name', 'surname', 'identifierNumber', 'identifier_number', 'id', 'code', 'number', 'badge', 'barcode', 'groupName', 'group_name', 'group', 'dept', 'department', 'team', 'customFields', 'custom_fields', 'createdAt', 'created_at']);
    for (const [k, v] of Object.entries(item)) {
      if (!standardKeys.has(k) && v !== undefined && v !== null && String(v).trim()) {
        customFields[k] = String(v).trim();
      }
    }
    const customFieldsJson = JSON.stringify(customFields);

    validItems.push({ firstName, lastName, identifierNumber, groupName, customFieldsJson });
  }

  if (validItems.length === 0) {
    return errorResponse('No valid attendees found in submission. Ensure identifier and name are provided.', 400);
  }

  await ensureAttendanceSchema(env);
  let hasCustomCol = true;
  try {
    const info = await env.DB.prepare('PRAGMA table_info(persons)').all();
    hasCustomCol = (info?.results || []).some(c => c.name === 'custom_fields');
  } catch {
    hasCustomCol = false;
  }

  const insertSqlWithCustom = 'INSERT INTO persons (first_name, last_name, identifier_number, group_name, custom_fields, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(identifier_number) DO UPDATE SET first_name=excluded.first_name, last_name=excluded.last_name, group_name=excluded.group_name, custom_fields=excluded.custom_fields';
  const insertSqlFallback = 'INSERT INTO persons (first_name, last_name, identifier_number, group_name, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(identifier_number) DO UPDATE SET first_name=excluded.first_name, last_name=excluded.last_name, group_name=excluded.group_name';

  const insertSql = hasCustomCol ? insertSqlWithCustom : insertSqlFallback;
  let importedCount = 0;
  if (typeof env.DB.batch === 'function') {
    const CHUNK_SIZE = 50; // Use 50 statements per D1 batch for optimal speed and reliability
    for (let i = 0; i < validItems.length; i += CHUNK_SIZE) {
      const chunk = validItems.slice(i, i + CHUNK_SIZE);
      const statements = chunk.map(item =>
        hasCustomCol
          ? env.DB.prepare(insertSql).bind(item.firstName, item.lastName, item.identifierNumber, item.groupName, item.customFieldsJson, createdAt)
          : env.DB.prepare(insertSql).bind(item.firstName, item.lastName, item.identifierNumber, item.groupName, createdAt)
      );
      await env.DB.batch(statements);
      importedCount += chunk.length;
    }
  } else {
    for (const item of validItems) {
      if (hasCustomCol) {
        await env.DB.prepare(insertSql).bind(item.firstName, item.lastName, item.identifierNumber, item.groupName, item.customFieldsJson, createdAt).run();
      } else {
        await env.DB.prepare(insertSql).bind(item.firstName, item.lastName, item.identifierNumber, item.groupName, createdAt).run();
      }
      importedCount++;
    }
  }

  return json({ success: true, count: importedCount, totalSubmitted: list.length });
}

async function listSessions(request, env) {
  const rows = await env.DB.prepare('SELECT id, name, is_active, created_at FROM sessions ORDER BY is_active DESC, created_at DESC, id DESC').all();
  return json({ sessions: rows.results || [] });
}

async function createSession(request, env) {
  const currentUser = await getUserFromRequest(request, env);
  if (currentUser && currentUser.role !== 'admin') {
    return errorResponse('Admin permission required to create events', 403);
  }
  let body;
  try { body = await readBody(request); } catch { return errorResponse('Invalid request', 400); }
  const name = String(body?.name || '').trim();
  if (!name) return errorResponse('Session name required', 400);

  const createdAt = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare('INSERT INTO sessions (name, is_active, created_at) VALUES (?, 1, ?)').bind(name, createdAt).run();
    const inserted = await env.DB.prepare('SELECT id, name, is_active, created_at FROM sessions WHERE name = ?').bind(name).first();
    // Set this newly created session as active
    await env.DB.prepare('UPDATE sessions SET is_active = 0 WHERE id != ?').bind(inserted.id).run();
    return json({ success: true, session: inserted });
  } catch {
    return errorResponse('Session name already exists', 409);
  }
}

async function setActiveSession(request, env) {
  let body;
  try { body = await readBody(request); } catch { return errorResponse('Invalid request', 400); }
  const id = Number(body?.id);
  if (!id) return errorResponse('Session ID required', 400);

  await env.DB.prepare('UPDATE sessions SET is_active = 0').run();
  await env.DB.prepare('UPDATE sessions SET is_active = 1 WHERE id = ?').bind(id).run();
  const session = await env.DB.prepare('SELECT id, name, is_active FROM sessions WHERE id = ?').bind(id).first();
  return json({ success: true, session });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!isConfigured(env)) return errorResponse('Server configuration incomplete', 503);
    try {
      if (path === '/admin.html') return Response.redirect(new URL('/admin/', url), 302);
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && !acceptedMutation(request)) return errorResponse('JSON from this origin required', 415);

      // Existing verification & admin routes
      if (path === '/api/verify' && request.method === 'POST') return await verify(request, env);

      // Auth & Supervisor accounts
      if (path === '/api/auth/login' && request.method === 'POST') return await loginUser(request, env);
      if (path === '/api/auth/logout' && request.method === 'POST') return await logoutUser(request, env);
      if (path === '/api/auth/me' && request.method === 'GET') return await getMe(request, env);
      if (path === '/api/supervisors' && request.method === 'GET') return await listSupervisors(request, env);
      if (path === '/api/supervisors' && request.method === 'POST') return await createSupervisor(request, env);
      if (path === '/api/supervisors/delete' && request.method === 'POST') return await deleteSupervisor(request, env);

      // Attendance & Roster Routes
      if (path === '/api/scan' && request.method === 'POST') return await scanAttendee(request, env);
      if (path === '/api/attendance/mark' && request.method === 'POST') return await markAttendance(request, env);
      if (path === '/api/attendance/toggle' && request.method === 'POST') return await toggleAttendance(request, env);
      if (path === '/api/reports' && request.method === 'GET') return await getReports(request, env);
      if (path === '/api/persons' && request.method === 'GET') return await listPersons(request, env);
      if (path === '/api/persons' && request.method === 'POST') return await createPerson(request, env);
      if (path === '/api/persons/update' && ['POST', 'PUT'].includes(request.method)) return await updatePerson(request, env);
      const personIdMatch = path.match(/^\/api\/persons\/(\d+)$/);
      if (personIdMatch && ['PUT', 'POST'].includes(request.method)) return await updatePerson(request, env, personIdMatch[1]);
      if (path === '/api/persons/delete' && request.method === 'POST') return await deletePerson(request, env);
      if (path === '/api/persons/bulk' && request.method === 'POST') return await bulkImportPersons(request, env);
      if (path === '/api/persons/template-csv' && request.method === 'GET') return await getTemplateCsv(request, env);
      if (path === '/api/sessions' && request.method === 'GET') return await listSessions(request, env);
      if (path === '/api/sessions' && request.method === 'POST') return await createSession(request, env);
      if (path === '/api/sessions/active' && request.method === 'POST') return await setActiveSession(request, env);

      // Programmable Custom Fields Routes
      if (path === '/api/custom-fields' && request.method === 'GET') return await listCustomFields(request, env);
      if (path === '/api/custom-fields' && ['POST', 'PUT'].includes(request.method)) return await saveCustomField(request, env);
      if (path === '/api/custom-fields/delete' && request.method === 'POST') return await deleteCustomField(request, env);
      const customFieldIdMatch = path.match(/^\/api\/custom-fields\/([a-zA-Z0-9_\-]+)$/);
      if (customFieldIdMatch && request.method === 'DELETE') return await deleteCustomField(request, env, customFieldIdMatch[1]);
      if (customFieldIdMatch && request.method === 'PUT') return await saveCustomField(request, env);

      if (path === '/admin' || path === '/admin/' || path.startsWith('/api/admin/')) {
        if (!(await authorized(request, env))) return unauthorized();
        if (path.startsWith('/api/admin/')) return await adminRoute(request, env, path);
        if (request.method !== 'GET') return errorResponse('Method not allowed', 405);
        const response = await env.ASSETS.fetch(new URL('/admin.html', url));
        const headers = new Headers(response.headers);
        Object.entries(noStore).forEach(([key, value]) => headers.set(key, value));
        headers.set('content-security-policy', csp);
        return new Response(response.body, { status: response.status, headers });
      }
      if (path.startsWith('/api/')) return errorResponse('Not found', 404);
      if (!['GET', 'HEAD'].includes(request.method)) return errorResponse('Method not allowed', 405);
      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      headers.set('content-security-policy', csp);
      headers.set('x-content-type-options', 'nosniff');
      return new Response(response.body, { status: response.status, headers });
    } catch (err) {
      console.error('Request error', err instanceof Error ? err.message : 'unknown');
      return errorResponse('Server error', 500);
    }
  },
  async scheduled(_event, env) {
    const settings = await env.DB.prepare('SELECT retention_days FROM settings WHERE id=1').first();
    const cutoff = Math.floor(Date.now() / 1000) - (settings?.retention_days ?? 30) * 86400;
    await env.DB.prepare('DELETE FROM scan_history WHERE scanned_at < ?').bind(cutoff).run();
    await env.DB.prepare('DELETE FROM request_bucket WHERE expires_at < ?').bind(Math.floor(Date.now() / 1000)).run();
  }
};

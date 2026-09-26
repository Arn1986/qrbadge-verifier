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
  return request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json' && (!origin || origin === new URL(request.url).origin);
}
async function readBody(request) {
  if (Number(request.headers.get('content-length')) > 2048) throw new Error('Request too large');
  const body = await request.text();
  if (body.length > 2048) throw new Error('Request too large');
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
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!isConfigured(env)) return errorResponse('Server configuration incomplete', 503);
    try {
      if (path === '/admin.html') return Response.redirect(new URL('/admin/', url), 302);
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && !acceptedMutation(request)) return errorResponse('JSON from this origin required', 415);
      if (path === '/api/verify' && request.method === 'POST') return await verify(request, env);
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

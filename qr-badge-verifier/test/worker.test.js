import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { decodeBadge, timeResult, toHex } from '../src/protocol.js';

const badgeKey = '00112233445566778899AABBCCDDEEFF';
const auth = `Basic ${btoa('admin:long-test-password')}`;
const createEnv = () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0002_rate_limit.sql', import.meta.url), 'utf8'));
  return {
    STORAGE_KEY_HEX: 'D4'.repeat(32), ADMIN_BASIC_USERNAME: 'admin', ADMIN_BASIC_PASSWORD: 'long-test-password',
    DB: { prepare(query) { return { bind(...values) { return wrap(query, values); }, ...wrap(query, []) }; } },
    ASSETS: { fetch: async () => new Response('ADMIN PAGE') }, sqlite
  };
  function wrap(query, values) {
    return { async first() { return sqlite.prepare(query).get(...values) ?? null; }, async all() { return { results: sqlite.prepare(query).all(...values) }; }, async run() { return sqlite.prepare(query).run(...values); } };
  }
};
async function makeQR({ identifier = 1234, startsAt = 1700000000, endsAt = 1900000000, timeType = 2, keyHex = badgeKey } = {}) {
  const plain = new Uint8Array(13);
  const view = new DataView(plain.buffer);
  view.setUint32(0, identifier, false); view.setUint8(4, timeType);
  view.setUint32(5, startsAt, false); view.setUint32(9, endsAt, false);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(keyHex.match(/../g), value => parseInt(value, 16)), 'AES-GCM', false, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  return toHex(Uint8Array.from([1, ...iv, ...encrypted]));
}
function req(path, method = 'GET', body, authorization = false) {
  return new Request(`https://example.test${path}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(authorization ? { Authorization: auth } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
test('protocol decodes real AES-GCM structure and validates time boundaries', async () => {
  const qr = await makeQR({ identifier: 4294967295 });
  assert.equal(qr.length, 84);
  assert.deepEqual(await decodeBadge(qr.toLowerCase(), badgeKey), { identifier: 4294967295, startsAt: 1700000000, endsAt: 1900000000 });
  assert.equal(timeResult(100, 200, 99), 'not_yet_valid');
  assert.equal(timeResult(100, 200, 100), 'valid');
  assert.equal(timeResult(100, 200, 200), 'expired');
  assert.equal((await decodeBadge(qr, 'FF'.repeat(16))).result, 'cannot_verify');
  assert.equal((await decodeBadge(qr.slice(0, -1) + (qr.endsWith('A') ? 'B' : 'A'), badgeKey)).result, 'cannot_verify');
  assert.equal((await decodeBadge('G'.repeat(84), badgeKey)).result, 'malformed');
  assert.equal((await decodeBadge(await makeQR({ timeType: 3 }), badgeKey)).result, 'unsupported');
});
test('admin authentication, active key replacement, verification, history, retention', async () => {
  const env = createEnv();
  assert.equal((await worker.fetch(req('/admin/'), env)).status, 401);
  assert.equal((await worker.fetch(req('/admin.html'), env)).status, 302);
  assert.equal((await worker.fetch(req('/api/admin/history'), env)).status, 401);
  assert.equal((await worker.fetch(req('/api/verify', 'POST', { hex: 'abc', source: 'paste' }), env)).status, 503);
  const setKey = await worker.fetch(req('/api/admin/key', 'PUT', { keyHex: badgeKey, confirmation: 'REPLACE' }, true), env);
  assert.equal(setKey.status, 200);
  assert.equal(env.sqlite.prepare('SELECT encrypted_key_hex FROM badge_key').get().encrypted_key_hex.includes(badgeKey), false);
  const qr = await makeQR({ startsAt: Math.floor(Date.now() / 1000) - 10, endsAt: Math.floor(Date.now() / 1000) + 60 });
  const response = await worker.fetch(req('/api/verify', 'POST', { hex: qr, source: 'camera' }), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.result, 'valid'); assert.equal(data.identifier, 1234);
  const history = await (await worker.fetch(req('/api/admin/history', 'GET', undefined, true), env)).json();
  assert.equal(history.total, 1); assert.equal(history.entries[0].identifier, 1234);
  assert.equal((await worker.fetch(req('/api/admin/retention', 'PUT', { retentionDays: 1 }, true), env)).status, 200);
  env.sqlite.prepare('UPDATE scan_history SET scanned_at=0').run();
  await worker.scheduled(null, env);
  assert.equal(env.sqlite.prepare('SELECT count(*) AS total FROM scan_history').get().total, 0);
  assert.equal((await worker.fetch(req('/api/admin/key', 'PUT', { keyHex: '11'.repeat(16), confirmation: 'REPLACE' }, true), env)).status, 200);
  const rejected = await (await worker.fetch(req('/api/verify', 'POST', { hex: qr, source: 'paste' }), env)).json();
  assert.equal(rejected.result, 'cannot_verify');
});
test('public verification caps requests without storing client IP addresses', async () => {
  const env = createEnv();
  await worker.fetch(req('/api/admin/key', 'PUT', { keyHex: badgeKey, confirmation: 'REPLACE' }, true), env);
  const originalNow = Date.now;
  Date.now = () => 1800000000000;
  try {
    for (let i = 0; i < 120; i++) {
      const result = await worker.fetch(req('/api/verify', 'POST', { hex: 'invalid', source: 'paste' }), env);
      assert.equal(result.status, 200);
    }
    const blocked = await worker.fetch(req('/api/verify', 'POST', { hex: 'invalid', source: 'paste' }), env);
    assert.equal(blocked.status, 429);
    assert.equal(env.sqlite.prepare('SELECT count(*) AS total FROM scan_history').get().total, 120);
    assert.equal(env.sqlite.prepare('SELECT count(*) AS total FROM request_bucket').get().total, 1);
  } finally { Date.now = originalNow; }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';

const createEnv = () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0002_rate_limit.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0003_attendance.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0004_supervisors_and_pwa.sql', import.meta.url), 'utf8'));

  return {
    STORAGE_KEY_HEX: 'D4'.repeat(32),
    ADMIN_BASIC_USERNAME: 'admin',
    ADMIN_BASIC_PASSWORD: 'admin123',
    DB: {
      prepare(query) {
        return {
          bind(...values) { return wrap(query, values); },
          ...wrap(query, [])
        };
      }
    },
    ASSETS: { fetch: async () => new Response('TEST') },
    sqlite
  };

  function wrap(query, values) {
    return {
      async first() { return sqlite.prepare(query).get(...values) ?? null; },
      async all() { return { results: sqlite.prepare(query).all(...values) }; },
      async run() { return sqlite.prepare(query).run(...values); }
    };
  }
};

function req(path, method = 'GET', body, token = null) {
  return new Request(`https://example.test${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}

test('multi-supervisor accounts, login, role permissions, and attendance attribution', async () => {
  const env = createEnv();

  // 1. Initial admin login with system credentials
  const adminLoginRes = await worker.fetch(req('/api/auth/login', 'POST', { username: 'admin', password: 'admin123' }), env);
  assert.equal(adminLoginRes.status, 200);
  const adminData = await adminLoginRes.json();
  assert.equal(adminData.user.role, 'admin');
  assert.ok(adminData.token);
  const adminToken = adminData.token;

  // Verify getMe for admin
  const meRes = await worker.fetch(req('/api/auth/me', 'GET', null, adminToken), env);
  assert.equal(meRes.status, 200);
  const meData = await meRes.json();
  assert.equal(meData.user.username, 'admin');

  // 2. Admin creates a new supervisor account
  const createSupRes = await worker.fetch(req('/api/supervisors', 'POST', {
    username: 'operator_sam',
    password: 'password123',
    displayName: 'Operator Sam'
  }, adminToken), env);
  assert.equal(createSupRes.status, 200);
  const supInfo = await createSupRes.json();
  assert.equal(supInfo.supervisor.username, 'operator_sam');
  assert.equal(supInfo.supervisor.display_name, 'Operator Sam');
  assert.equal(supInfo.supervisor.role, 'supervisor');

  // List supervisors
  const listSupRes = await worker.fetch(req('/api/supervisors', 'GET', null, adminToken), env);
  const supList = await listSupRes.json();
  assert.ok(supList.supervisors.some(s => s.username === 'operator_sam'));

  // 3. Supervisor logs in with their credentials
  const supLoginRes = await worker.fetch(req('/api/auth/login', 'POST', {
    username: 'operator_sam',
    password: 'password123'
  }), env);
  assert.equal(supLoginRes.status, 200);
  const supLoginData = await supLoginRes.json();
  assert.equal(supLoginData.user.role, 'supervisor');
  assert.equal(supLoginData.user.displayName, 'Operator Sam');
  const supToken = supLoginData.token;

  // Supervisor tries to create another supervisor (must be forbidden 403)
  const forbiddenCreate = await worker.fetch(req('/api/supervisors', 'POST', {
    username: 'hacker',
    password: '123',
    displayName: 'Hacker'
  }, supToken), env);
  assert.equal(forbiddenCreate.status, 403);

  // 4. Admin adds a person to roster
  const addPersonRes = await worker.fetch(req('/api/persons', 'POST', {
    firstName: 'Elena',
    lastName: 'Rostova',
    identifierNumber: 'ID-9922',
    groupName: 'Engineering'
  }, adminToken), env);
  assert.equal(addPersonRes.status, 200);
  const person = (await addPersonRes.json()).person;

  // 5. Supervisor scans the person
  const scanRes = await worker.fetch(req('/api/scan', 'POST', {
    raw: 'ID-9922',
    sessionId: 1,
    source: 'camera'
  }, supToken), env);
  assert.equal(scanRes.status, 200);
  const scanData = await scanRes.json();
  assert.equal(scanData.found, true);
  assert.equal(scanData.person.firstName, 'Elena');
  assert.equal(scanData.alreadyPresent, false);

  // 6. Supervisor confirms attendance check-in
  const markRes = await worker.fetch(req('/api/attendance/mark', 'POST', {
    sessionId: 1,
    personId: person.id,
    source: 'camera'
  }, supToken), env);
  assert.equal(markRes.status, 200);
  const markData = await markRes.json();
  assert.equal(markData.success, true);
  assert.equal(markData.verifiedByName, 'Operator Sam');

  // 7. Check reports to verify supervisor attribution
  const reportRes = await worker.fetch(req('/api/reports?sessionId=1', 'GET', null, supToken), env);
  assert.equal(reportRes.status, 200);
  const report = await reportRes.json();
  assert.equal(report.total, 1);
  assert.equal(report.present, 1);
  assert.equal(report.missing, 0);
  assert.equal(report.groups[0].members[0].verifiedByName, 'Operator Sam');

  // 8. Logout
  const logoutRes = await worker.fetch(req('/api/auth/logout', 'POST', { token: supToken }), env);
  assert.equal(logoutRes.status, 200);

  const meAfterLogout = await worker.fetch(req('/api/auth/me', 'GET', null, supToken), env);
  assert.equal(meAfterLogout.status, 401);
});

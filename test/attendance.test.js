import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { toHex } from '../src/protocol.js';

const badgeKey = '00112233445566778899AABBCCDDEEFF';
const auth = `Basic ${btoa('admin:long-test-password')}`;

const createEnv = () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0002_rate_limit.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0003_attendance.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0004_supervisors_and_pwa.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0005_add_verified_by_columns.sql', import.meta.url), 'utf8'));
  return {
    STORAGE_KEY_HEX: 'D4'.repeat(32),
    ADMIN_BASIC_USERNAME: 'admin',
    ADMIN_BASIC_PASSWORD: 'long-test-password',
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

async function makeQR({ identifier = 1234, startsAt = 1700000000, endsAt = 1900000000, timeType = 2, keyHex = badgeKey } = {}) {
  const plain = new Uint8Array(13);
  const view = new DataView(plain.buffer);
  view.setUint32(0, identifier, false);
  view.setUint8(4, timeType);
  view.setUint32(5, startsAt, false);
  view.setUint32(9, endsAt, false);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(keyHex.match(/../g), value => parseInt(value, 16)), 'AES-GCM', false, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  return toHex(Uint8Array.from([1, ...iv, ...encrypted]));
}

function req(path, method = 'GET', body, authorization = false) {
  return new Request(`https://example.test${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(authorization ? { Authorization: auth } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}

test('attendance roster creation, bulk import, plain scan, encrypted scan, reports', async () => {
  const env = createEnv();

  // Configure active key for badge decryption
  await worker.fetch(req('/api/admin/key', 'PUT', { keyHex: badgeKey, confirmation: 'REPLACE' }, true), env);

  // 1. Add single person
  const addRes = await worker.fetch(req('/api/persons', 'POST', {
    firstName: 'Maria',
    lastName: 'Santos',
    identifierNumber: '104829',
    groupName: 'Engineering'
  }), env);
  assert.equal(addRes.status, 200);
  const addData = await addRes.json();
  assert.equal(addData.success, true);
  assert.equal(addData.person.firstName, 'Maria');

  // 2. Bulk import persons
  const bulkRes = await worker.fetch(req('/api/persons/bulk', 'POST', {
    persons: [
      { firstName: 'John', lastName: 'Doe', identifierNumber: '1234', groupName: 'Engineering' },
      { firstName: 'Samira', lastName: 'Patel', identifierNumber: '55412', groupName: 'Marketing' },
      { firstName: 'Alex', lastName: 'Chen', identifierNumber: '77881', groupName: 'Design' }
    ]
  }), env);
  assert.equal(bulkRes.status, 200);
  const bulkData = await bulkRes.json();
  assert.equal(bulkData.count, 3);

  // 3. Verify persons list
  const listRes = await worker.fetch(req('/api/persons', 'GET'), env);
  const listData = await listRes.json();
  assert.equal(listData.persons.length, 4);
  assert.deepEqual(listData.groups.sort(), ['Design', 'Engineering', 'Marketing'].sort());

  // 4. Session management
  const sessionRes = await worker.fetch(req('/api/sessions', 'GET'), env);
  const sessionData = await sessionRes.json();
  assert.equal(sessionData.sessions.length, 1);
  const activeSessionId = sessionData.sessions[0].id;

  // 5. Scan by plain identifier number (Maria Santos: 104829)
  const plainScanRes = await worker.fetch(req('/api/scan', 'POST', {
    raw: '104829',
    sessionId: activeSessionId,
    source: 'camera'
  }), env);
  assert.equal(plainScanRes.status, 200);
  const plainScanData = await plainScanRes.json();
  assert.equal(plainScanData.found, true);
  assert.equal(plainScanData.person.firstName, 'Maria');
  assert.equal(plainScanData.alreadyPresent, false);

  // 6. Mark Maria as present
  const markRes = await worker.fetch(req('/api/attendance/mark', 'POST', {
    sessionId: activeSessionId,
    personId: plainScanData.person.id,
    source: 'camera'
  }), env);
  assert.equal(markRes.status, 200);

  // Rescan Maria -> should show already present
  const rescanRes = await worker.fetch(req('/api/scan', 'POST', {
    raw: '104829',
    sessionId: activeSessionId,
    source: 'camera'
  }), env);
  const rescanData = await rescanRes.json();
  assert.equal(rescanData.alreadyPresent, true);

  // 7. Scan by 84-hex encrypted badge (John Doe: 1234)
  const qrHex = await makeQR({ identifier: 1234 });
  const qrScanRes = await worker.fetch(req('/api/scan', 'POST', {
    raw: qrHex,
    sessionId: activeSessionId,
    source: 'camera'
  }), env);
  assert.equal(qrScanRes.status, 200);
  const qrScanData = await qrScanRes.json();
  assert.equal(qrScanData.found, true);
  assert.equal(qrScanData.person.firstName, 'John');
  assert.equal(qrScanData.person.identifierNumber, '1234');
  assert.equal(qrScanData.alreadyPresent, false);

  // 8. Scan unknown identifier
  const unknownScan = await (await worker.fetch(req('/api/scan', 'POST', {
    raw: '99999999',
    sessionId: activeSessionId,
    source: 'paste'
  }), env)).json();
  assert.equal(unknownScan.found, false);
  assert.equal(unknownScan.person, null);

  // 9. Check Reports
  const reportRes = await worker.fetch(req(`/api/reports?sessionId=${activeSessionId}`, 'GET'), env);
  assert.equal(reportRes.status, 200);
  const reportData = await reportRes.json();
  assert.equal(reportData.total, 4);
  assert.equal(reportData.present, 1); // Only Maria marked so far
  assert.equal(reportData.missing, 3);
  assert.equal(reportData.percent, 25);

  const engGroup = reportData.groups.find(g => g.groupName === 'Engineering');
  assert.ok(engGroup);
  assert.equal(engGroup.total, 2);
  assert.equal(engGroup.present, 1);
  assert.equal(engGroup.missing, 1);
  assert.equal(engGroup.percent, 50);

  // 10. Toggle attendance manually
  const toggleRes = await worker.fetch(req('/api/attendance/toggle', 'POST', {
    sessionId: activeSessionId,
    personId: qrScanData.person.id // John Doe
  }), env);
  const toggleData = await toggleRes.json();
  assert.equal(toggleData.isPresent, true);

  const reportAfterToggle = await (await worker.fetch(req(`/api/reports?sessionId=${activeSessionId}`, 'GET'), env)).json();
  assert.equal(reportAfterToggle.present, 2);
  assert.equal(reportAfterToggle.percent, 50);
});

test('large bulk roster import of 500 attendees processes without error', async () => {
  const env = createEnv();

  // Create admin user in SQLite memory
  const hash = '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918';
  env.sqlite.prepare('INSERT INTO users (username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)').run('admin', hash, 'Admin', 'admin', 1700000000);
  env.sqlite.prepare('INSERT INTO user_tokens (token, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)').run('test-admin-token', 1700000000, 2000000000);

  // Generate 500 attendee objects
  const attendees500 = [];
  for (let i = 1; i <= 500; i++) {
    attendees500.push({
      firstName: `Attendee${i}`,
      lastName: `Test`,
      identifierNumber: `BULK-ID-${i}`,
      groupName: i % 2 === 0 ? 'Engineering' : 'Marketing'
    });
  }

  const bulkReq = new Request('https://example.test/api/persons/bulk', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: 'Bearer test-admin-token'
    },
    body: JSON.stringify({ persons: attendees500 })
  });

  const res = await worker.fetch(bulkReq, env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.count, 500);

  // Verify attendees stored in database
  const countRow = env.sqlite.prepare('SELECT count(*) as count FROM persons WHERE identifier_number LIKE \'BULK-ID-%\'').get();
  assert.equal(countRow.count, 500);
});

test('unmigrated attendance table without verified_by columns operates gracefully without crashing', async () => {
  // Create an environment that has NOT applied migration 0005
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0002_rate_limit.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0003_attendance.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0004_supervisors_and_pwa.sql', import.meta.url), 'utf8'));
  // Note: 0005 is intentionally NOT executed here to simulate user's unmigrated D1 state!

  const env = {
    STORAGE_KEY_HEX: 'D4'.repeat(32),
    ADMIN_BASIC_USERNAME: 'admin',
    ADMIN_BASIC_PASSWORD: 'long-test-password',
    DB: {
      prepare(query) {
        return {
          bind(...values) {
            return {
              async first() { return sqlite.prepare(query).get(...values) ?? null; },
              async all() { return { results: sqlite.prepare(query).all(...values) }; },
              async run() { return sqlite.prepare(query).run(...values); }
            };
          },
          async first() { return sqlite.prepare(query).get() ?? null; },
          async all() { return { results: sqlite.prepare(query).all() }; },
          async run() { return sqlite.prepare(query).run(); }
        };
      }
    },
    ASSETS: { fetch: async () => new Response('TEST') }
  };

  // Add person
  sqlite.prepare('INSERT INTO persons (first_name, last_name, identifier_number, group_name, created_at) VALUES (?, ?, ?, ?, ?)').run('Grace', 'Hopper', 'GH-001', 'Computing', 1700000000);
  const person = sqlite.prepare('SELECT id FROM persons WHERE identifier_number = ?').get('GH-001');

  // 1. Mark attendance on unmigrated table
  const markReq = new Request('https://example.test/api/attendance/mark', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 1, personId: person.id, source: 'camera', verifiedByName: 'Operator Alice' })
  });
  const markRes = await worker.fetch(markReq, env);
  assert.equal(markRes.status, 200);
  const markData = await markRes.json();
  assert.equal(markData.success, true);

  // 2. Fetch reports on unmigrated table - should NOT throw no such column error!
  const reportReq = new Request('https://example.test/api/reports?sessionId=1', { method: 'GET' });
  const reportRes = await worker.fetch(reportReq, env);
  assert.equal(reportRes.status, 200);
  const reportData = await reportRes.json();
  assert.equal(reportData.total, 1);
  assert.equal(reportData.present, 1);
  assert.equal(reportData.groups[0].members[0].isPresent, true);
});


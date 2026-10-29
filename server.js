import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import worker from './src/worker.js';
import { toHex, fromHex } from './src/protocol.js';

// Load environment variables if available
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch {}
}

if (fs.existsSync('.dev.vars')) {
  try {
    const devVars = fs.readFileSync('.dev.vars', 'utf8');
    for (const line of devVars.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key] && !val.startsWith('REPLACE_WITH_')) {
          process.env[key] = val;
        }
      }
    }
  } catch {}
}

const PORT = 3000;
const dataDir = path.resolve('data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Persistent or configured storage encryption key
let storageKeyHex = process.env.STORAGE_KEY_HEX;
const storageKeyFile = path.join(dataDir, '.storage_key');
if (!storageKeyHex || !/^[a-fA-F0-9]{64}$/.test(storageKeyHex)) {
  if (fs.existsSync(storageKeyFile)) {
    storageKeyHex = fs.readFileSync(storageKeyFile, 'utf8').trim();
  }
  if (!storageKeyHex || !/^[a-fA-F0-9]{64}$/.test(storageKeyHex)) {
    storageKeyHex = crypto.randomBytes(32).toString('hex').toUpperCase();
    try {
      fs.writeFileSync(storageKeyFile, storageKeyHex, 'utf8');
    } catch {}
  }
}

const adminUsername = process.env.ADMIN_BASIC_USERNAME || 'admin';
const adminPassword = process.env.ADMIN_BASIC_PASSWORD || 'admin123';

// SQLite database setup with D1-compatible interface
const dbPath = path.join(dataDir, 'verifier.db');
const sqlite = new DatabaseSync(dbPath);

// Apply migrations
const migration1 = fs.readFileSync(new URL('./migrations/0001_initial.sql', import.meta.url), 'utf8');
const migration2 = fs.readFileSync(new URL('./migrations/0002_rate_limit.sql', import.meta.url), 'utf8');
const migration3 = fs.readFileSync(new URL('./migrations/0003_attendance.sql', import.meta.url), 'utf8');
const migration4 = fs.readFileSync(new URL('./migrations/0004_supervisors_and_pwa.sql', import.meta.url), 'utf8');
const migration5 = fs.readFileSync(new URL('./migrations/0005_add_verified_by_columns.sql', import.meta.url), 'utf8');
const migration6 = fs.readFileSync(new URL('./migrations/0006_add_custom_fields.sql', import.meta.url), 'utf8');
const migration7 = fs.readFileSync(new URL('./migrations/0007_custom_field_definitions.sql', import.meta.url), 'utf8');
sqlite.exec(migration1);
sqlite.exec(migration2);
sqlite.exec(migration3);
sqlite.exec(migration4);
try {
  sqlite.exec(migration5);
} catch {}
try {
  sqlite.exec(migration6);
} catch {}
try {
  sqlite.exec(migration7);
} catch {}

// Safely ensure verified_by columns exist on attendance_records
try {
  const tableInfo = sqlite.prepare('PRAGMA table_info(attendance_records)').all();
  const columnNames = tableInfo.map(c => c.name);
  if (!columnNames.includes('verified_by_name')) {
    sqlite.exec('ALTER TABLE attendance_records ADD COLUMN verified_by_name TEXT;');
  }
  if (!columnNames.includes('verified_by_id')) {
    sqlite.exec('ALTER TABLE attendance_records ADD COLUMN verified_by_id INTEGER;');
  }
} catch (e) {
  console.warn('Column check note:', e.message);
}

// Safely ensure custom_fields column exists on persons
try {
  const personTableInfo = sqlite.prepare('PRAGMA table_info(persons)').all();
  const personCols = personTableInfo.map(c => c.name);
  if (!personCols.includes('custom_fields')) {
    sqlite.exec("ALTER TABLE persons ADD COLUMN custom_fields TEXT DEFAULT '{}';");
  }
} catch (e) {
  console.warn('Person column check note:', e.message);
}

// Safely ensure custom_field_definitions table exists and has helpful seed definitions
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS custom_field_definitions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL DEFAULT 'text',
    options TEXT DEFAULT '[]',
    is_required INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  )`);
  const fieldCount = sqlite.prepare('SELECT count(*) as count FROM custom_field_definitions').get();
  if (fieldCount && fieldCount.count === 0) {
    sqlite.prepare('INSERT INTO custom_field_definitions (id, name, type, options, is_required, sort_order) VALUES (?, ?, ?, ?, ?, ?)').run(
      'fld-ticket-type',
      'Ticket Type',
      'select',
      JSON.stringify(['VIP All-Access', 'General Pass', 'Staff', 'Speaker']),
      0,
      1
    );
    sqlite.prepare('INSERT INTO custom_field_definitions (id, name, type, options, is_required, sort_order) VALUES (?, ?, ?, ?, ?, ?)').run(
      'fld-seat-number',
      'Seat Number',
      'text',
      '[]',
      0,
      2
    );
    console.log('Seeded default custom fields: Ticket Type, Seat Number');
  }
} catch (e) {
  console.warn('Custom field definitions table note:', e.message);
}

// Seed default admin and supervisor accounts if table empty
try {
  const userCount = sqlite.prepare('SELECT count(*) as count FROM users').get();
  if (userCount && userCount.count === 0) {
    const createdAt = Math.floor(Date.now() / 1000);
    const adminHash = crypto.createHash('sha256').update('qrpass-salt:admin123').digest('hex');
    const supHash = crypto.createHash('sha256').update('qrpass-salt:supervisor123').digest('hex');
    sqlite.prepare('INSERT INTO users (username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)').run('admin', adminHash, 'Administrator', 'admin', createdAt);
    sqlite.prepare('INSERT INTO users (username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)').run('supervisor1', supHash, 'Supervisor Alex', 'supervisor', createdAt);
    sqlite.prepare('INSERT INTO users (username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)').run('supervisor2', supHash, 'Supervisor Jordan', 'supervisor', createdAt);
    console.log('Seeded default admin (admin / admin123) and supervisors (supervisor1, supervisor2 / supervisor123).');
  }
} catch (e) {
  console.warn('User seed note:', e.message);
}

function wrap(query, values) {
  return {
    async first() {
      const stmt = sqlite.prepare(query);
      return stmt.get(...values) ?? null;
    },
    async all() {
      const stmt = sqlite.prepare(query);
      return { results: stmt.all(...values) };
    },
    async run() {
      const stmt = sqlite.prepare(query);
      return stmt.run(...values);
    }
  };
}

const DB = {
  prepare(query) {
    return {
      bind(...values) {
        return wrap(query, values);
      },
      ...wrap(query, [])
    };
  },
  async batch(statements) {
    sqlite.exec('BEGIN TRANSACTION');
    try {
      const results = [];
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      sqlite.exec('COMMIT');
      return results;
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw err;
    }
  }
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg'
};

const publicDir = path.resolve('public');

const ASSETS = {
  async fetch(resource) {
    let pathname;
    if (typeof resource === 'string') {
      pathname = new URL(resource, 'http://localhost').pathname;
    } else if (resource instanceof URL) {
      pathname = resource.pathname;
    } else if (resource && typeof resource.url === 'string') {
      pathname = new URL(resource.url).pathname;
    } else {
      pathname = '/index.html';
    }
    pathname = decodeURIComponent(pathname);
    if (pathname === '/' || pathname === '') {
      pathname = '/index.html';
    }
    const safePath = path.normalize(path.join(publicDir, pathname));
    if (!safePath.startsWith(publicDir)) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const stats = await fs.promises.stat(safePath);
      let targetFile = safePath;
      if (stats.isDirectory()) {
        targetFile = path.join(safePath, 'index.html');
      }
      const data = await fs.promises.readFile(targetFile);
      const ext = path.extname(targetFile).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      return new Response(data, {
        status: 200,
        headers: {
          'content-type': contentType,
          'content-length': String(data.byteLength)
        }
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  }
};

const env = {
  STORAGE_KEY_HEX: storageKeyHex,
  ADMIN_BASIC_USERNAME: adminUsername,
  ADMIN_BASIC_PASSWORD: adminPassword,
  DB,
  ASSETS
};

// Seed a default demo badge key if no key is configured yet
const existingKey = await DB.prepare('SELECT id FROM badge_key WHERE id = 1').first();
if (!existingKey) {
  try {
    const defaultKeyHex = '00112233445566778899AABBCCDDEEFF';
    const key = await crypto.subtle.importKey('raw', fromHex(storageKeyHex), 'AES-GCM', false, ['encrypt', 'decrypt']);
    const hash = await crypto.subtle.digest('SHA-256', fromHex(defaultKeyHex));
    const fingerprint = toHex(new Uint8Array(hash).slice(0, 8));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('qr-badge-verifier:key:v1') },
      key,
      new TextEncoder().encode(defaultKeyHex)
    );
    const updatedAt = Math.floor(Date.now() / 1000);
    await DB.prepare(
      'INSERT INTO badge_key (id, iv_hex, encrypted_key_hex, fingerprint, updated_at) VALUES (1, ?, ?, ?, ?)'
    ).bind(toHex(iv), toHex(new Uint8Array(encrypted)), fingerprint, updatedAt).run();
    console.log('Initialized default badge key (00112233445566778899AABBCCDDEEFF). Admin can replace it in /admin/.');
  } catch (err) {
    console.warn('Could not seed default badge key:', err.message);
  }
}

// Seed initial persons roster if empty
try {
  const personCount = await DB.prepare('SELECT count(*) as count FROM persons').first();
  if (personCount && personCount.count === 0) {
    const samplePersons = [
      ['John', 'Doe', '1234', 'Engineering'],
      ['Maria', 'Santos', '104829', 'Product'],
      ['Alex', 'Chen', '77881', 'Design'],
      ['Samira', 'Patel', '55412', 'Marketing'],
      ['David', 'Kim', '12345', 'Engineering'],
      ['Emma', 'Wilson', '99100', 'Product'],
      ['Liam', 'O\'Connor', '88204', 'Operations'],
      ['Sophia', 'Martinez', '66301', 'Operations']
    ];
    const createdAt = Math.floor(Date.now() / 1000);
    for (const [fn, ln, idNum, grp] of samplePersons) {
      await DB.prepare(
        'INSERT INTO persons (first_name, last_name, identifier_number, group_name, created_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(fn, ln, idNum, grp, createdAt).run();
    }
    console.log('Seeded sample attendance roster with 8 attendees across 4 groups.');
  }
} catch (err) {
  console.warn('Could not seed sample persons:', err.message);
}

// Scheduled retention and rate-limit bucket cleanup (every hour)
setInterval(() => {
  worker.scheduled(null, env).catch(err => {
    console.error('Scheduled cleanup error:', err);
  });
}, 3600000);

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const bodyBuffer = Buffer.concat(chunks);

    const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
    let baseOrigin = `${proto}://${host}`;
    if (req.headers.origin) {
      try {
        const originUrl = new URL(req.headers.origin);
        if (originUrl.host === host) {
          baseOrigin = originUrl.origin;
        }
      } catch {}
    }

    const fullUrl = new URL(req.url, baseOrigin).toString();

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) headers.append(key, item);
      } else {
        headers.set(key, value);
      }
    }

    if (!headers.has('cf-connecting-ip')) {
      const clientIp = req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.socket.remoteAddress || '127.0.0.1';
      headers.set('cf-connecting-ip', clientIp);
    }

    const webRequest = new Request(fullUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyBuffer
    });

    const webResponse = await worker.fetch(webRequest, env);

    res.statusCode = webResponse.status;
    for (const [key, value] of webResponse.headers.entries()) {
      res.setHeader(key, value);
    }

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const responseArrayBuffer = await webResponse.arrayBuffer();
    res.end(Buffer.from(responseArrayBuffer));
  } catch (err) {
    console.error('Server error processing request:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`QR badge verifier server running on http://0.0.0.0:${PORT}`);
});

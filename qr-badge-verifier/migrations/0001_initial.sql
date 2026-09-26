CREATE TABLE IF NOT EXISTS badge_key (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  iv_hex TEXT NOT NULL,
  encrypted_key_hex TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  retention_days INTEGER NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 3650)
);
INSERT OR IGNORE INTO settings (id, retention_days) VALUES (1, 30);
CREATE TABLE IF NOT EXISTS scan_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scanned_at INTEGER NOT NULL,
  result TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('camera','paste')),
  identifier INTEGER,
  starts_at INTEGER,
  ends_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_history_scanned_at ON scan_history(scanned_at DESC);

-- Persons roster table
CREATE TABLE IF NOT EXISTS persons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  identifier_number TEXT NOT NULL UNIQUE,
  group_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_persons_identifier ON persons(identifier_number);
CREATE INDEX IF NOT EXISTS idx_persons_group ON persons(group_name);

-- Attendance sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- Seed default active session if none exists
INSERT OR IGNORE INTO sessions (id, name, is_active, created_at) VALUES (1, 'General Attendance', 1, 1700000000);

-- Attendance check-in records table
CREATE TABLE IF NOT EXISTS attendance_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  person_id INTEGER NOT NULL,
  identifier_number TEXT NOT NULL,
  scanned_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'present',
  source TEXT NOT NULL CHECK (source IN ('camera', 'paste', 'manual')),
  verified_by_name TEXT,
  verified_by_id INTEGER,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY(person_id) REFERENCES persons(id) ON DELETE CASCADE,
  UNIQUE(session_id, person_id)
);
CREATE INDEX IF NOT EXISTS idx_attendance_session ON attendance_records(session_id);
CREATE INDEX IF NOT EXISTS idx_attendance_person ON attendance_records(person_id);

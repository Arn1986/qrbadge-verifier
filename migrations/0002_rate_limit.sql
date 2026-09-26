CREATE TABLE IF NOT EXISTS request_bucket (
  bucket_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_bucket_expires ON request_bucket(expires_at);

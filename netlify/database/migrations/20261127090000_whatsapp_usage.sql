-- 每则发出去的 WhatsApp 讯息（用来算每个月用了多少；删除行程也不会少算）
CREATE TABLE IF NOT EXISTS wa_sent (
  id SERIAL PRIMARY KEY,
  event_id INTEGER,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS wa_sent_at_idx ON wa_sent (sent_at);

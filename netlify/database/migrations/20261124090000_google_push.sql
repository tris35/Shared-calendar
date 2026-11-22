-- 快速双向同步：Google 推送通知（有变更时 Google 会马上通知 App）
ALTER TABLE google_links ADD COLUMN IF NOT EXISTS watch_id TEXT;
ALTER TABLE google_links ADD COLUMN IF NOT EXISTS watch_resource TEXT;
ALTER TABLE google_links ADD COLUMN IF NOT EXISTS watch_expires TIMESTAMPTZ;
-- 同一时间只读一次；读的时候有新通知就再读一遍
ALTER TABLE google_links ADD COLUMN IF NOT EXISTS pull_lease TIMESTAMPTZ;
ALTER TABLE google_links ADD COLUMN IF NOT EXISTS pull_again BOOLEAN NOT NULL DEFAULT FALSE;

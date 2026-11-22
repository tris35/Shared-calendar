-- 双向同步：从 Google 日历读回变更
ALTER TABLE google_links ADD COLUMN IF NOT EXISTS sync_token TEXT;          -- Google 增量同步的位置
ALTER TABLE google_links ADD COLUMN IF NOT EXISTS last_pull_at TIMESTAMPTZ; -- 上次从 Google 读取的时间
ALTER TABLE google_links ADD COLUMN IF NOT EXISTS calendar_name TEXT;       -- 正在同步的 Google 日历名称（例如「拍摄」）
ALTER TABLE event_google ADD COLUMN IF NOT EXISTS etag TEXT;                -- 我们最后一次写入 Google 的版本（用来忽略自己写的变更）

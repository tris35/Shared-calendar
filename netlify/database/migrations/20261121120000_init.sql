CREATE TABLE members (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#4f9d69',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  start TIMESTAMPTZ NOT NULL,
  "end" TIMESTAMPTZ,
  all_day BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  label TEXT,                       -- 颜色标签（对应 Google 日历的 11 种颜色）
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  remind BOOLEAN NOT NULL DEFAULT TRUE,  -- 前一天 12:00 Google 日历通知
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX events_start_idx ON events (start);

CREATE TABLE photos (
  id SERIAL PRIMARY KEY,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  blob_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  caption TEXT,
  author TEXT,                      -- 谁上传的
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 留言：photo_id 为 NULL = 行程的留言；有值 = 照片下面的评论
CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  photo_id INTEGER REFERENCES photos(id) ON DELETE CASCADE,
  author TEXT,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 行程的变更纪录（「Janny 修改了标题」）
CREATE TABLE event_log (
  id SERIAL PRIMARY KEY,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  author TEXT,
  action TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX event_log_event_idx ON event_log (event_id);

-- 个人帐号（用 Gmail 注册）
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,       -- 小写
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 每个人连接自己的 Google 日历
CREATE TABLE google_links (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  gmail TEXT NOT NULL,              -- 要同步到的 Gmail（用户自己填的）
  refresh_token TEXT NOT NULL,
  calendar_id TEXT NOT NULL,        -- App 在他的 Google 日历建立的「共享日历」
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 每个行程在每个人 Google 日历里的对应
CREATE TABLE event_google (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  google_event_id TEXT NOT NULL,
  synced_at TIMESTAMPTZ,
  error TEXT,
  PRIMARY KEY (event_id, user_id)
);


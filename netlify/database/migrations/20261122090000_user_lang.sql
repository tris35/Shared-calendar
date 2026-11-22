-- 每个帐号的介面语言：en / zh / zh-TW / ms
ALTER TABLE users ADD COLUMN IF NOT EXISTS lang TEXT NOT NULL DEFAULT 'en';

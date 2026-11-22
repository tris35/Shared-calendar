-- 只有管理员允许的帐号可以设定/发送 WhatsApp 给客户
ALTER TABLE users ADD COLUMN IF NOT EXISTS wa_allowed BOOLEAN NOT NULL DEFAULT FALSE;

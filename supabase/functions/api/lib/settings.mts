// 设置：存在资料库的 kv 表（只有服务器端读得到，不会出现在网页里）
import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { DEFAULT_TZ } from "./time.mts";
import { getKv, setKv } from "./db.mts";
import { apiBase } from "./env.mts";

export type Settings = {
  timezone: string;
  secret: string;              // 用来签名（照片链接、订阅链接、Google 登录）
  waLimit?: number | null;     // 每个月最多发几则 WhatsApp（例如 Kapso 免费方案的上限）；空 = 不限
  cronKey: string;             // 资料库排程（pg_cron）呼叫 /api/cron/* 时用的密钥
  cronUrl?: string;            // 排程要呼叫的网址（这个函数自己的网址，自动记下）
  labelNames?: Record<string, string>; // 颜色标签的自订名称（例如 番茄红 = 拍摄），所有人共用
  digest?: Digest;             // WhatsApp 行程摘要（每天 / 每周）
  adminEmails?: string[];      // 在 App「设置」加的管理员（另外还有 Supabase 密钥 ADMIN_EMAILS）
};

export type Digest = {
  mode: "off" | "daily" | "weekly"; // 每天早上：今天的行程；每周一早上：这个星期的行程
  hour: number;                     // 几点发（App 时区）
  phones: string[];                 // 收件人电话
  lastSent?: string;                // 最后一次发送的日期（YYYY-MM-DD），避免重复
};

/** 在 App 里加的管理员（小写），getSettings / saveSettings 时更新 */
export let extraAdmins: string[] = [];

let cache: { at: number; value: Settings } | null = null;

export async function getSettings(): Promise<Settings> {
  if (cache && Date.now() - cache.at < 5000) return cache.value;
  const s = ((await getKv("app")) as Partial<Settings> | null) ?? {};
  let changed = false;
  if (!s.secret) { s.secret = crypto.randomBytes(32).toString("hex"); changed = true; }
  if (!s.cronKey) { s.cronKey = crypto.randomBytes(24).toString("hex"); changed = true; }
  if (!s.timezone) { s.timezone = DEFAULT_TZ; changed = true; }
  const base = apiBase();
  if (base && s.cronUrl !== base) { s.cronUrl = base; changed = true; }
  if (changed) await setKv("app", s);
  cache = { at: Date.now(), value: s as Settings };
  extraAdmins = (s.adminEmails || []).map((x) => x.toLowerCase());
  return s as Settings;
}

export async function saveSettings(patch: Partial<Settings>) {
  const s = { ...(await getSettings()), ...patch };
  await setKv("app", s);
  cache = { at: Date.now(), value: s };
  extraAdmins = (s.adminEmails || []).map((x) => x.toLowerCase());
  return s;
}

export async function sign(text: string) {
  const { secret } = await getSettings();
  return crypto.createHmac("sha256", secret).update(text).digest("hex").slice(0, 32);
}
export async function verify(text: string, sig: string) {
  const good = await sign(text);
  return typeof sig === "string" && sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
export const photoSignature = (photoId: number) => sign(`photo:${photoId}`);
export const verifyPhotoSignature = (photoId: number, sig: string) => verify(`photo:${photoId}`, sig);

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
};

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
  return s as Settings;
}

export async function saveSettings(patch: Partial<Settings>) {
  const s = { ...(await getSettings()), ...patch };
  await setKv("app", s);
  cache = { at: Date.now(), value: s };
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

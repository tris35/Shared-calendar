// 设置：存在 Netlify Blobs（只有服务器端读得到，不会出现在网页里）
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { DEFAULT_TZ } from "./time.mts";

const store = () => getStore({ name: "settings", consistency: "strong" });

export type Settings = {
  timezone: string;
  secret: string;              // 用来签名（照片链接、订阅链接、Google 登录）
  waLimit?: number | null;     // 每个月最多发几则 WhatsApp（例如 Kapso 免费方案的上限）；空 = 不限
};

let cache: { at: number; value: Settings } | null = null;

export async function getSettings(): Promise<Settings> {
  if (cache && Date.now() - cache.at < 5000) return cache.value;
  const s = ((await store().get("app", { type: "json" })) as Partial<Settings> | null) ?? {};
  let changed = false;
  if (!s.secret) { s.secret = crypto.randomBytes(32).toString("hex"); changed = true; }
  if (!s.timezone) { s.timezone = DEFAULT_TZ; changed = true; }
  if (changed) await store().setJSON("app", s);
  cache = { at: Date.now(), value: s as Settings };
  return s as Settings;
}

export async function saveSettings(patch: Partial<Settings>) {
  const s = { ...(await getSettings()), ...patch };
  await store().setJSON("app", s);
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

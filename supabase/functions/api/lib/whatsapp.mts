// 给客户的 WhatsApp 讯息（WhatsApp Business Cloud API）
// 行程前一天下午 4 点（App 时区）自动发送；也可以在行程页按「立即发送」。
// WhatsApp 规定：主动发给客户的讯息必须用 Meta 审核过的「讯息模板」，模板里的 {{1}} 换成你写的讯息。
import * as db from "./db.mts";
import { env } from "./env.mts";
import { wallToUtc } from "./time.mts";
import { getSettings } from "./settings.mts";

export const SEND_HOUR = 16; // 下午 4 点

// 两种接法：Kapso（KAPSO_API_KEY，推荐）或直接用 Meta（WHATSAPP_TOKEN）
export function waConfig() {
  const kapso = env("KAPSO_API_KEY"), token = env("WHATSAPP_TOKEN"), phoneId = env("WHATSAPP_PHONE_NUMBER_ID");
  if (!(kapso || token) || !phoneId) return null;
  return {
    phoneId,
    headers: kapso ? { "X-API-Key": kapso } : { Authorization: `Bearer ${token}` },
    template: env("WHATSAPP_TEMPLATE") || "customer_note",
    lang: env("WHATSAPP_TEMPLATE_LANG") || "en",
    version: env("WHATSAPP_API_VERSION") || (kapso ? "v24.0" : "v23.0"),
    base: env("WHATSAPP_API_BASE") || (kapso ? "https://api.kapso.ai/meta/whatsapp" : "https://graph.facebook.com"),
    cc: (env("WHATSAPP_COUNTRY_CODE") || "60").replace(/\D/g, ""),
  };
}

/** 012-345 6789 → 60123456789（没写国码就加上默认国码，马来西亚 60） */
export function normPhone(raw: string, cc = "60") {
  const s = String(raw || "").trim();
  let d = s.replace(/\D/g, "");
  if (!d) return "";
  if (s.startsWith("+")) { /* 已有国码 */ }
  else if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = cc + d.slice(1);
  else if (!d.startsWith(cc)) d = cc + d;
  return d.length >= 8 && d.length <= 15 ? d : "";
}

/** WhatsApp 模板的参数不能有换行 → 换行变成「 | 」 */
export function flattenNote(note: string) {
  return String(note || "").replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean).join(" | ")
    .replace(/\t/g, " ").replace(/ {4,}/g, "   ").slice(0, 1000);
}

/** 行程开始 → 发送时间（前一天下午 4 点，当地时间） */
export function customerSendAt(startIso: string, tz: string) {
  const ymd = new Date(startIso).toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
  const [y, m, d] = ymd.split("-").map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d) - 86400_000).toISOString().slice(0, 10);
  return wallToUtc(prev, SEND_HOUR, 0, tz);
}

/** 这个月（App 时区）用了几则、上限几则 */
export async function waUsage() {
  const { timezone, waLimit } = await getSettings();
  const ym = new Date().toLocaleDateString("en-CA", { timeZone: timezone }).slice(0, 7); // YYYY-MM
  const sent = await db.countWaSentSince(wallToUtc(`${ym}-01`, 0, 0, timezone));
  const limit = waLimit && waLimit > 0 ? waLimit : null;
  return { sent, limit, full: limit != null && sent >= limit };
}

async function sendTemplate(to: string, text: string) {
  const c = waConfig();
  if (!c) throw new Error("WhatsApp 还没设定");
  const res = await fetch(`${c.base}/${c.version}/${c.phoneId}/messages`, {
    method: "POST",
    headers: { ...c.headers, "Content-Type": "application/json" } as unknown as Record<string, string>,
    body: JSON.stringify({
      messaging_product: "whatsapp", to, type: "template",
      template: { name: c.template, language: { code: c.lang }, components: [{ type: "body", parameters: [{ type: "text", text }] }] },
    }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data?.error || {};
    throw new Error(`WhatsApp 错误：${[e.message, e.error_data?.details].filter(Boolean).join(" – ") || res.status}`);
  }
  return data?.messages?.[0]?.id as string | undefined;
}

/** 发送某个行程给客户的讯息；force = 手动立即发送（就算已经发过） */
export async function sendCustomerMessage(eventId: number, opts: { force?: boolean; author?: string | null } = {}) {
  const c = waConfig();
  if (!c) throw new Error("WhatsApp 还没设定");
  const e: any = await db.getEvent(eventId);
  if (!e) throw new Error("找不到");
  if (!e.customer_phone) throw new Error("请填写客户电话");
  if (!e.customer_note) throw new Error("请填写给客户的讯息");
  const to = normPhone(e.customer_phone, c.cc);
  if (!to) { await db.setCustomerError(eventId, "电话号码不正确"); throw new Error("电话号码不正确"); }
  const usage = await waUsage();
  if (usage.full) {
    const msg = `本月 WhatsApp 讯息已用完（${usage.limit} 则）`;
    await db.setCustomerError(eventId, msg);
    throw new Error(msg);
  }
  if (!(await db.claimCustomerSend(eventId, !!opts.force))) return { skipped: true };
  try {
    await sendTemplate(to, flattenNote(e.customer_note));
    await db.recordWaSent(eventId);
    await db.logEvent(eventId, opts.author ?? null, "customer_sent");
    return { ok: true };
  } catch (err: any) {
    const msg = String(err?.message || err);
    await db.setCustomerError(eventId, msg);
    await db.logEvent(eventId, opts.author ?? null, "customer_failed");
    throw err;
  }
}

/** 排程：发送到时间的讯息（前一天下午 4 点之后、行程开始之前） */
export async function sendDueCustomerMessages() {
  if (!waConfig()) return { skipped: true };
  const { timezone } = await getSettings();
  let sent = 0, failed = 0;
  for (const e of await db.pendingCustomerMessages()) {
    if (customerSendAt(new Date(e.start).toISOString(), timezone).getTime() > Date.now()) continue;
    try { const r: any = await sendCustomerMessage(e.id); if (r.ok) sent++; }
    catch (err: any) { failed++; console.error(`[WhatsApp] 行程 ${e.id} 发送失败：`, err?.message || err); }
  }
  return { sent, failed };
}

// 同步到 Google 日历（单向：本 App → Google 日历）。不使用 Google Drive。
// 每个人用自己的帐号连接「自己填的 Gmail」：App 在那个 Gmail 的 Google 日历里建立「共享日历」，之后自动更新。
// 每个行程：标题、时间、颜色、成员、备注、所有留言（谁、什么时候），照片以「看照片」链接列出
// （Google 日历不能直接显示图片），前一天 12:00 由 Google 日历通知。
import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";
import * as db from "./db.mts";
import { env } from "./env.mts";
import { getSettings, sign, verify, photoSignature, type Settings } from "./settings.mts";
import { reminderAt, wallToUtc } from "./time.mts";
import { desc, normLang, LOCALES, type Lang } from "./i18n.mts";

const API = env("GOOGLE_API_BASE") || "https://www.googleapis.com";        // 本地测试可改
const TOKEN_URL = env("GOOGLE_TOKEN_URL") || "https://oauth2.googleapis.com/token";
const AUTH_URL = env("GOOGLE_AUTH_URL") || "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar"];
type Link = { user_id: number; gmail: string; refresh_token: string; calendar_id: string };

export function clientCredentials() {
  const id = env("GOOGLE_CLIENT_ID"), secret = env("GOOGLE_CLIENT_SECRET");
  return id && secret ? { id, secret } : null;
}
// 一律用网站主网址（Netlify 的 URL 环境变量），不要用每次部署都不同的预览网址
export const mainUrl = (siteUrl: string) => (env("URL") || siteUrl).replace(/\/$/, "");
export const redirectUri = (siteUrl: string) => `${mainUrl(siteUrl)}/api/google/callback`;
const b64 = (s: string) => Buffer.from(s).toString("base64url");

// ---------- 连接自己的 Gmail ----------
export async function authUrl(siteUrl: string, userId: number, gmail: string) {
  const c = clientCredentials();
  if (!c) throw new Error("App 还没设定 Google 登录（Netlify 环境变量 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET）");
  const g = gmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(g)) throw new Error("请输入正确的 Gmail 地址");
  const ts = String(Date.now());
  const state = `${ts}.${userId}.${b64(g)}.${await sign(`oauth:${ts}:${userId}:${g}`)}`;
  const u = new URL(AUTH_URL);
  u.search = new URLSearchParams({
    client_id: c.id, redirect_uri: redirectUri(siteUrl), response_type: "code", scope: SCOPES.join(" "),
    access_type: "offline", prompt: "consent", login_hint: g, state,
  }).toString();
  return u.toString();
}

async function tokenRequest(params: Record<string, string>) {
  const res = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.error === "invalid_grant") throw new Error("Google 授权已失效，请到「设置」重新连接 Google 日历");
    throw new Error(`Google 登录失败：${data.error_description || data.error || res.status}`);
  }
  return data;
}

/** Google 授权完成后回到这里。只接受用户填的那个 Gmail。 */
export async function handleCallback(url: URL) {
  const err = url.searchParams.get("error");
  if (err) throw new Error(err === "access_denied" ? "你取消了 Google 授权" : `Google 授权失败：${err}`);
  const [ts, uid, g64, sig] = (url.searchParams.get("state") || "").split(".");
  const userId = Number(uid);
  const gmail = g64 ? Buffer.from(g64, "base64url").toString() : "";
  if (!ts || !userId || !(await verify(`oauth:${ts}:${userId}:${gmail}`, sig || "")) || Date.now() - Number(ts) > 15 * 60_000)
    throw new Error("连接已过期，请重新按「连接 Google 日历」");
  const c = clientCredentials();
  if (!c) throw new Error("App 还没设定 Google 登录");
  const tok = await tokenRequest({
    code: url.searchParams.get("code") || "", client_id: c.id, client_secret: c.secret,
    redirect_uri: redirectUri(url.origin), grant_type: "authorization_code",
  });
  let chosen = "";
  try { chosen = String(JSON.parse(Buffer.from(String(tok.id_token).split(".")[1], "base64url").toString()).email || "").toLowerCase(); } catch {}
  if (chosen !== gmail) {
    if (tok.access_token) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tok.access_token)}`, { method: "POST" }).catch(() => {});
    throw new Error(`你选了 ${chosen || "另一个帐号"}，但你填的是 ${gmail}。请重新连接，并在 Google 画面选择 ${gmail}`);
  }
  if (!tok.refresh_token) throw new Error("Google 没有给长期授权，请到 myaccount.google.com/permissions 移除本 App 后再连接一次");
  if (!String(tok.scope || "").includes("auth/calendar")) throw new Error("请在 Google 授权画面勾选「日历」权限");

  const { timezone } = await getSettings();
  const old = await db.getGoogleLink(userId);
  const link: Link = { user_id: userId, gmail, refresh_token: tok.refresh_token, calendar_id: old?.gmail === gmail ? old.calendar_id : "" };
  tokenCache.set(link.refresh_token, { token: tok.access_token, exp: Date.now() + (tok.expires_in ?? 3600) * 1000 });
  const lang = normLang((await db.getUser(userId))?.lang);
  if (!link.calendar_id || !(await calendarExists(link))) link.calendar_id = await createCalendar(link, timezone, lang);
  if (old?.gmail !== gmail || old?.calendar_id !== link.calendar_id) await db.clearEventGoogle(userId); // 新日历 → 全部重新同步
  await db.saveGoogleLink(link);
  if (!old || old.calendar_id !== link.calendar_id) await db.switchGoogleCalendar(userId, link.calendar_id, desc(lang, "calendar"));
  return link;
}

const tokenCache = new Map<string, { token: string; exp: number }>();
async function accessToken(l: Link) {
  const hit = tokenCache.get(l.refresh_token);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const c = clientCredentials();
  if (!c) throw new Error("App 还没设定 Google 登录");
  const tok = await tokenRequest({ refresh_token: l.refresh_token, client_id: c.id, client_secret: c.secret, grant_type: "refresh_token" });
  tokenCache.set(l.refresh_token, { token: tok.access_token, exp: Date.now() + (tok.expires_in ?? 3600) * 1000 });
  return tok.access_token as string;
}
async function gfetch(l: Link, path: string, init: RequestInit = {}) {
  const token = await accessToken(l);
  return fetch(`${API}/calendar/v3${path}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}
async function gerror(res: Response) {
  const data: any = await res.json().catch(() => ({}));
  const msg = data?.error?.message || res.statusText;
  if (res.status === 401) return "Google 授权已失效，请到「设置」重新连接 Google 日历";
  if (res.status === 404) return `Google 日历上找不到（${msg}）`;
  return `Google 日历错误 ${res.status}：${msg}`;
}
async function calendarExists(l: Link) {
  return (await gfetch(l, `/calendars/${encodeURIComponent(l.calendar_id)}`)).ok;
}
async function createCalendar(l: Link, tz: string, lang: Lang) {
  const res = await gfetch(l, "/calendars", { method: "POST", body: JSON.stringify({ summary: desc(lang, "calendar"), timeZone: tz, description: desc(lang, "calDesc") }) });
  if (!res.ok) throw new Error(await gerror(res));
  return ((await res.json()) as any).id as string;
}

/** 取消连接：撤销授权（Google 日历上已同步的内容会保留） */
export async function disconnect(userId: number) {
  const l = await db.getGoogleLink(userId);
  if (l) {
    await stopWatch(l as any);
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(l.refresh_token)}`, { method: "POST" }).catch(() => {});
    tokenCache.delete(l.refresh_token);
  }
  await db.deleteGoogleLink(userId);
}

// ---------- 活动内容（Google 同步和订阅链接共用） ----------
export const fmtShort = (iso: string, tz: string, lang: Lang = "en") =>
  new Date(iso).toLocaleString(LOCALES[lang], { timeZone: tz, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
export const dateOnly = (iso: string, tz: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
export function addDays(ymd: string, n: number) {
  const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}

/** 活动说明：成员、备注、每则留言（谁、什么时候）、照片链接。html=false 时输出纯文字（订阅链接用） */
export async function eventDescription(e: any, siteUrl: string, tz: string, html = true, lang: Lang = "en") {
  const link = (url: string, text: string) => (html ? `<a href="${url}">${text}</a>` : `${text}: ${url}`);
  const L = (k: string) => desc(lang, k);
  const feed = await db.eventFeed(e.id);
  const lines: string[] = [];
  if (e.member_name) lines.push(`👤 ${e.member_name}`);
  if (e.notes) lines.push(e.notes);
  const posts = feed.filter((f: any) => f.type !== "log");
  if (posts.length) {
    lines.push("", L("posts"));
    for (const f of posts as any[]) {
      const who = `${f.author || L("anon")} (${fmtShort(f.created_at, tz, lang)})`;
      if (f.type === "comment") lines.push(`• ${who}: ${f.body}`);
      else {
        const url = `${siteUrl}/p/${f.id}?s=${await photoSignature(f.id)}`;
        lines.push(`• ${who} ${L("uploaded")}${f.caption ? ": " + f.caption : ""} → ${link(url, L("view"))}`);
        if (f.comment_count) for (const c of await db.listComments({ photo_id: f.id })) lines.push(`    ↳ ${c.author || L("anon")} (${fmtShort(c.created_at, tz, lang)}): ${c.body}`);
      }
    }
  }
  lines.push("", link(`${siteUrl}/#event-${e.id}`, L("open")));
  return lines.join("\n");
}

async function buildGoogleEvent(e: any, siteUrl: string, s: Settings, lang: Lang) {
  const tz = s.timezone;
  const timing = e.all_day
    ? (() => {
        const sd = dateOnly(e.start, tz), ed = e.end ? dateOnly(e.end, tz) : sd;
        return { start: { date: sd }, end: { date: addDays(ed, 1) } }; // Google 全天活动的结束日不含当天
      })()
    : { start: { dateTime: e.start, timeZone: tz }, end: { dateTime: e.end || new Date(new Date(e.start).getTime() + 3600_000).toISOString(), timeZone: tz } };
  const reminders: any = { useDefault: false, overrides: [] };
  if (e.remind) { // 前一天 12:00
    const minutes = e.all_day ? 12 * 60 : Math.round((new Date(e.start).getTime() - reminderAt(e.start, tz).getTime()) / 60000);
    if (minutes > 0 && minutes <= 40320) reminders.overrides.push({ method: "popup", minutes });
  }
  return {
    summary: e.title,
    description: await eventDescription(e, siteUrl, tz, true, lang),
    ...timing,
    ...(e.label ? { colorId: e.label } : {}),
    reminders,
    extendedProperties: { private: { familyCalendarId: String(e.id) } },
    source: { title: desc(lang, "calendar"), url: `${siteUrl}/#event-${e.id}` },
    status: "confirmed",
  };
}

/** 每个人、每个行程用固定的活动 ID（只用 0-9 a-v），同时多次同步也不会重复建立 */
function googleIdFor(eventId: number, userId: number, secret: string) {
  return `fc${crypto.createHash("sha256").update(`${secret}:${userId}`).digest("hex").slice(0, 10)}e${eventId}`;
}

async function syncOne(l: Link, e: any, body: any, s: Settings) {
  const prev = await db.getEventGoogle(e.id, l.user_id);
  const gid = prev?.google_event_id || googleIdFor(e.id, l.user_id, s.secret);
  try {
    const json = JSON.stringify({ ...body, id: gid });
    const cal = encodeURIComponent(l.calendar_id);
    const put = () => gfetch(l, `/calendars/${cal}/events/${encodeURIComponent(gid)}`, { method: "PUT", body: json });
    let res = await put();                                   // 已存在 → 更新
    if (res.status === 404 || res.status === 410) {
      res = await gfetch(l, `/calendars/${cal}/events`, { method: "POST", body: json }); // 不存在 → 建立
      if (res.status === 409) res = await put();             // 别的同步刚建立了 → 改成更新
    }
    if (!res.ok) throw new Error(await gerror(res));
    const saved: any = await res.json().catch(() => ({}));
    // 记住我们写入的版本：之后从 Google 读回时，看到同一个版本就知道是自己写的，不会当成别人修改
    await db.setEventGoogle(e.id, l.user_id, { google_event_id: gid, etag: saved.etag ?? null });
    return { ok: true };
  } catch (err: any) {
    const error = String(err?.message || err);
    await db.setEventGoogle(e.id, l.user_id, { google_event_id: gid, error }).catch(() => {});
    console.error(`[Google 日历] 行程 #${e.id} → ${l.gmail} 同步失败：${error}`);
    return { ok: false, error };
  }
}

/** 把一个行程写入/更新到每个已连接的人的 Google 日历（onlyUserId：只同步某个人） */
export async function syncEvent(eventId: number, siteUrl: string, onlyUserId?: number, exceptUserId?: number) {
  const links = (await db.listGoogleLinks()).filter((l: any) => (!onlyUserId || l.user_id === onlyUserId) && l.user_id !== exceptUserId);
  if (!links.length) return { skipped: true };
  const e = await db.getEvent(eventId);
  if (!e) return { skipped: true };
  const s = await getSettings();
  // 每个人的 Google 日历用他自己的语言写说明
  const bodies = new Map<Lang, any>();
  const results = await Promise.all(links.map(async (l: any) => {
    const lang = normLang((await db.getUser(l.user_id))?.lang);
    if (!bodies.has(lang)) bodies.set(lang, await buildGoogleEvent(e, siteUrl, s, lang));
    return syncOne(l, e, bodies.get(lang), s);
  }));
  const failed = results.filter((r) => !r.ok) as any[];
  return failed.length ? { ok: false, error: failed[0].error } : { ok: true };
}

/** 行程被删除前先取对应，删除后再删掉每个人 Google 日历上的那一笔 */
export async function deleteGoogleEvents(mappings: { user_id: number; google_event_id: string }[]) {
  if (!mappings.length) return;
  const links = new Map((await db.listGoogleLinks()).map((l: any) => [l.user_id, l]));
  for (const m of mappings) {
    const l: any = links.get(m.user_id);
    if (!l) continue;
    try {
      const res = await gfetch(l, `/calendars/${encodeURIComponent(l.calendar_id)}/events/${encodeURIComponent(m.google_event_id)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404 && res.status !== 410) console.error("[Google 日历] 删除失败：", await gerror(res));
    } catch (err) { console.error("[Google 日历] 删除失败：", err); }
  }
}

// ======================= 从 Google 日历读回来 =======================

const LABEL_IDS = new Set(Object.keys(db.LABELS));
/** Google 活动的说明可能是 HTML，转成纯文字 */
function plainText(html: string | undefined) {
  if (!html) return null;
  const t = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_, href, text) => (text && text !== href ? `${text} ${href}` : href))
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return t.replace(/\n{3,}/g, "\n\n").trim() || null;
}
/** Google 活动 → App 行程的栏位 */
function fromGoogle(ev: any, tz: string, withNotes: boolean) {
  const allDay = !!ev.start?.date;
  let start: string, end: string | null;
  if (allDay) {
    start = wallToUtc(ev.start.date, 0, 0, tz).toISOString();
    const lastDay = addDays(ev.end?.date || ev.start.date, -1); // Google 全天活动的结束日不含当天
    end = lastDay > ev.start.date ? wallToUtc(lastDay, 23, 59, tz).toISOString() : null;
  } else {
    start = new Date(ev.start.dateTime).toISOString();
    end = ev.end?.dateTime ? new Date(ev.end.dateTime).toISOString() : null;
  }
  const out: any = { title: (ev.summary || "(无标题)").slice(0, 300), start, end, all_day: allDay, label: LABEL_IDS.has(String(ev.colorId)) ? String(ev.colorId) : null };
  if (withNotes) {
    const extra = (ev.attachments || []).map((a: any) => `📎 ${a.title || "附件"}: ${a.fileUrl}`);
    const loc = ev.location ? [`📍 ${ev.location}`] : [];
    const notes = [plainText(ev.description), ...loc, ...extra].filter(Boolean).join("\n");
    out.notes = notes ? notes.slice(0, 5000) : null;
  }
  return out;
}

/** 列出这个人 Google 帐号里的日历（让他选要导入哪一个） */
export async function listGoogleCalendars(userId: number) {
  const l = await db.getGoogleLink(userId);
  if (!l) throw new Error("你还没连接 Google 日历");
  const res = await gfetch(l, "/users/me/calendarList?minAccessRole=reader&maxResults=250");
  if (!res.ok) throw new Error(await gerror(res));
  const data: any = await res.json();
  return (data.items || [])
    .filter((c: any) => !String(c.id).includes("#holiday@") && ["owner", "writer"].includes(c.accessRole))
    .map((c: any) => ({ id: c.id, name: c.summaryOverride || c.summary, primary: !!c.primary, current: c.id === l.calendar_id }));
}

/** 改成和另一个 Google 日历双向同步（例如「拍摄」）。之后由 pull 读入它的活动，由 sync-all 写入 App 的活动 */
export async function switchSyncCalendar(userId: number, calendarId: string) {
  const l = await db.getGoogleLink(userId);
  if (!l) throw new Error("你还没连接 Google 日历");
  if (calendarId === l.calendar_id) return { id: calendarId, name: (l as any).calendar_name || calendarId, unchanged: true }; // 已经在同步这个日历
  const res = await gfetch(l, `/users/me/calendarList/${encodeURIComponent(calendarId)}`);
  if (!res.ok) throw new Error(await gerror(res));
  const c: any = await res.json();
  if (!["owner", "writer"].includes(c.accessRole)) throw new Error("这个日历没有修改权限，不能双向同步");
  const name = c.summaryOverride || c.summary || calendarId;
  await stopWatch(l as any);
  await db.switchGoogleCalendar(userId, calendarId, name);
  return { id: calendarId, name };
}


/**
 * 双向同步：读取某人 Google「共享日历」里的变更，写回 App
 * - 在 Google 新增的活动 → 新增到 App
 * - 在 Google 改了标题 / 时间 / 颜色 → 更新 App（备注、留言、照片仍在 App 里改）
 * - 在 Google 删除 → App 里也删除（连同留言、照片），其他人的 Google 日历也会删除
 */
export async function pullFromGoogle(userId: number, siteUrl: string, opts: { minSeconds?: number; deadline?: number } = {}) {
  const minSeconds = opts.minSeconds ?? 60;
  if (minSeconds > 0 && !(await db.claimPull(userId, minSeconds))) return { skipped: true };
  // 同一时间只读一次；正在读的时候收到新通知 → 读完再读一遍
  await db.requestPull(userId);
  if (!(await db.takePullLease(userId))) return { skipped: true, busy: true };
  const deadline = opts.deadline ?? Date.now() + 20_000;
  const total: any = { ok: true, created: 0, updated: 0, deleted: 0, done: false };
  let released = false;
  try {
    for (;;) {
      await db.clearPullAgain(userId);
      const r: any = await pullOnce(userId, siteUrl, deadline);
      if (!r.ok) return r;
      total.created += r.created; total.updated += r.updated; total.deleted += r.deleted; total.done = r.done;
      if (!r.done || Date.now() > deadline) return total; // 还没读完 → 下次继续
      if (await db.releasePullLease(userId)) { released = true; return total; }
    }
  } finally {
    if (!released) await db.releasePullLease(userId, true);
  }
}

async function pullOnce(userId: number, siteUrl: string, deadline: number) {
  // sync_token 以 "p:" 开头 = 第一次完整读取还没读完，记着读到哪一页
  const l: any = await db.getGoogleLink(userId);
  if (!l?.calendar_id) return { ok: false, skipped: true };
  const user = await db.getUser(userId);
  const who = `${user?.name || l.gmail} · Google`;
  const { timezone } = await getSettings();
  let pageToken: string | null = l.sync_token?.startsWith("p:") ? l.sync_token.slice(2) : null;
  let syncToken: string | null = l.sync_token?.startsWith("p:") ? null : l.sync_token;
  let done = false;
  let created = 0, updated = 0, deleted = 0;
  const touched = new Set<number>();   // 在 Google 修改的 → 推给其他人
  const createdIds = new Set<number>(); // 在 Google 新增的 → 也写回这个人的 Google（加上 App 的标记，之后才认得出来）
  try {
    for (;;) {
      const q = new URLSearchParams({ maxResults: "250", showDeleted: "true" });
      if (pageToken) q.set("pageToken", pageToken);
      else if (syncToken) q.set("syncToken", syncToken);
      const res = await gfetch(l, `/calendars/${encodeURIComponent(l.calendar_id)}/events?${q}`);
      if (res.status === 410) { syncToken = null; pageToken = null; await db.setLinkSync(userId, { sync_token: null }); continue; } // 位置过期 → 全部重读
      if (!res.ok) throw new Error(await gerror(res));
      const data: any = await res.json();
      for (const ev of data.items || []) {
        const map = await db.findEventGoogle(userId, ev.id);
        if (ev.status === "cancelled") {
          if (map) {
            // 在 Google 删除了 → App 也删除，并删掉其他人 Google 日历里的那一笔
            const others = (await db.listEventGoogle(map.event_id)).filter((m: any) => m.user_id !== userId);
            const photos = await db.listPhotos(map.event_id);
            if (await db.deleteEvent(map.event_id)) {
              for (const p of photos) await getStore("photos").delete(p.blob_key).catch(() => {});
              await deleteGoogleEvents(others as any);
              touched.delete(map.event_id);
              createdIds.delete(map.event_id);
              deleted++;
            }
          }
          continue;
        }
        if (map) {
          if (map.etag && map.etag === ev.etag) continue; // 是我们自己写的版本
          const cur = await db.getEvent(map.event_id);
          if (!cur) continue;
          const g = fromGoogle(ev, timezone, false);
          const diff: any = {};
          for (const k of ["title", "start", "end", "label"]) if ((g as any)[k] !== (cur as any)[k] && !(g[k] == null && cur[k] == null)) diff[k] = (g as any)[k];
          if (g.all_day !== !!cur.all_day) diff.all_day = g.all_day;
          await db.setEventGoogle(map.event_id, userId, { google_event_id: ev.id, etag: ev.etag });
          if (Object.keys(diff).length) { await db.updateEvent(map.event_id, diff, who); touched.add(map.event_id); updated++; }
          continue;
        }
        // 没有对应：是在 Google 新增的
        const own = ev.extendedProperties?.private?.familyCalendarId;
        if (own && (await db.getEvent(Number(own)))) { // 本来就是 App 的行程，只是对应不见了 → 接回去
          await db.setEventGoogle(Number(own), userId, { google_event_id: ev.id, etag: ev.etag });
          continue;
        }
        const e = await db.createEvent({ ...fromGoogle(ev, timezone, true), remind: true }, who);
        await db.setEventGoogle(e.id, userId, { google_event_id: ev.id, etag: ev.etag });
        createdIds.add(e.id);
        created++;
      }
      if (data.nextPageToken) {
        pageToken = data.nextPageToken;
        if (Date.now() > deadline) { await db.setLinkSync(userId, { sync_token: "p:" + pageToken }); break; } // 下次从这一页继续
        continue;
      }
      if (data.nextSyncToken) await db.setLinkSync(userId, { sync_token: data.nextSyncToken });
      done = true;
      break;
    }
    // 把改动推给其他人的 Google 日历（也会把这个人的那笔更新成 App 的格式）
    // 推给其他人的 Google 日历（这个人的 Google 已经是最新的，不用再写）
    for (const id of createdIds) { if (Date.now() > deadline + 8_000) break; await syncEvent(id, siteUrl); }
    for (const id of touched) { if (Date.now() > deadline + 8_000) break; await syncEvent(id, siteUrl, undefined, userId); }
    return { ok: true, created, updated, deleted, done };
  } catch (err: any) {
    console.error(`[Google 日历] 从 ${l.gmail} 读取失败：`, err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  }
}

/** 排程用：读取所有人的 Google 变更 */
export async function pullAll(siteUrl: string) {
  const deadline = Date.now() + 22_000;
  for (const l of await db.listGoogleLinks()) {
    if (Date.now() > deadline) break;
    await ensureWatch(l.user_id, siteUrl).catch((e) => console.error(e));
    await pullFromGoogle(l.user_id, siteUrl, { minSeconds: 120, deadline });
  }
}

// ---------- 快速同步：Google 推送通知 ----------
// Google 日历有变更时，Google 会马上通知 /api/google/push，App 再去读变更（几秒内同步）。
// 通知频道最长约 30 天，排程会在到期前自动续约。
const WATCH_TTL = 30 * 86400; // 秒
export async function ensureWatch(userId: number, siteUrl: string) {
  const l: any = await db.getGoogleLink(userId);
  if (!l?.calendar_id) return;
  if (l.watch_id && l.watch_expires && new Date(l.watch_expires).getTime() > Date.now() + 2 * 86400_000) return; // 还有效
  const address = `${mainUrl(siteUrl)}/api/google/push`;
  if (!address.startsWith("https://") && !env("GOOGLE_API_BASE")) return; // Google 只通知 https 网址
  await stopWatch(l);
  const id = crypto.randomUUID();
  const token = `${userId}.${await sign(`watch:${userId}:${id}`)}`;
  const res = await gfetch(l, `/calendars/${encodeURIComponent(l.calendar_id)}/events/watch`, {
    method: "POST", body: JSON.stringify({ id, type: "web_hook", address, token, params: { ttl: String(WATCH_TTL) } }),
  });
  if (!res.ok) { console.error("[Google 日历] 无法开启推送通知：", await gerror(res)); return; }
  const d: any = await res.json();
  await db.setWatch(userId, { id, resource: d.resourceId || null, expires: new Date(Number(d.expiration) || Date.now() + WATCH_TTL * 1000) });
}
async function stopWatch(l: any) {
  if (!l?.watch_id || !l?.watch_resource) return;
  await gfetch(l, "/channels/stop", { method: "POST", body: JSON.stringify({ id: l.watch_id, resourceId: l.watch_resource }) }).catch(() => {});
  await db.setWatch(l.user_id, { id: null, resource: null, expires: null });
}
/** Google 的通知：验证是谁的频道，回传要读取的 userId（不是有效通知回传 null） */
export async function pushTarget(req: Request) {
  const channel = req.headers.get("x-goog-channel-id") || "";
  const [uid, sig] = (req.headers.get("x-goog-channel-token") || "").split(".");
  const userId = Number(uid);
  if (!userId || !channel || !(await verify(`watch:${userId}:${channel}`, sig || ""))) return null;
  const l: any = await db.getGoogleLink(userId);
  if (!l || l.watch_id !== channel) return null; // 旧频道
  if (req.headers.get("x-goog-resource-state") === "sync") return null; // 开通时的测试通知
  return userId;
}

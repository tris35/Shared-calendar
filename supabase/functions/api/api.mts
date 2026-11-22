// 共享日历 API（Supabase Edge Function）：/api/*
// 除了注册、登录和 Google 授权回调，其他都要先登录（个人帐号）。
import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { apiBase, later } from "./lib/env.mts";
import { putPhoto, getPhotoData, deletePhotoData } from "./lib/photos.mts";
import * as db from "./lib/db.mts";
import { getSettings, saveSettings, sign } from "./lib/settings.mts";
import { chat, claudeEnabled } from "./lib/claude.mts";
import { syncEvent, deleteGoogleEvents, authUrl, handleCallback, disconnect, clientCredentials, redirectUri, mainUrl, listGoogleCalendars, listSyncCalendars, setCalendarEnabled, switchSyncCalendar, retryFailedSyncs, pullFromGoogle, ensureWatch, pushTarget } from "./lib/gcal.mts";
import { AuthError, signup, login, currentUser, changePassword, publicUser, isAdmin, canWhatsApp, fixedAdmins } from "./lib/auth.mts";
import { waConfig, sendCustomerMessage, sendTimeFor, waUsage, buildDigest } from "./lib/whatsapp.mts";
import { tr, langFrom, normLang, LANG_CODES, desc } from "./lib/i18n.mts";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
}
const notFound = (): never => { throw new HttpError(404, "找不到"); };

async function savePhotos(files: File[], eventId: number | null, author: string | null) {
  const out: any[] = [];
  for (const f of files) {
    if (!(f instanceof File) || !IMAGE_TYPES.has(f.type)) continue;
    if (f.size > MAX_PHOTO_BYTES) throw new Error("照片太大（上限 4MB）");
    const key = crypto.randomUUID();
    const buf = await f.arrayBuffer();
    await putPhoto(key, buf, f.type);
    out.push({ ...(await db.addPhoto({ event_id: eventId, blob_key: key, mime: f.type, author })), _buf: buf });
  }
  return out;
}
const strip = (rows: any[]) => rows.map(({ _buf, blob_key, ...p }) => p);

export async function handleApi(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // 一律用主网址（照片链接、Google 日历里的链接都不会指向会过期/私人的测试网址）
  const siteUrl = mainUrl(url.origin);
  const method = req.method.toUpperCase();
  const seg = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const id = Number(seg[1]);
  const body = async () => (await req.json().catch(() => ({}))) as any;
  let lang = langFrom(req);
  // 资料改动后，在背景同步每个人的 Google 日历（不拖慢回应）
  const sync = (eventId: number | null | undefined) => { if (eventId) later(syncEvent(eventId, siteUrl)); };

  try {
    // ---------- 不用登录的 ----------
    if (seg[0] === "auth" && method === "POST") {
      if (seg[1] === "signup") return Response.json(await signup(await body()));
      if (seg[1] === "login") return Response.json(await login(await body()));
    }
    // Google 推送通知：Google 日历有变更 → 马上读回 App
    if (seg[0] === "google" && seg[1] === "push" && method === "POST") {
      const userId = await pushTarget(req);
      if (userId) later(pullFromGoogle(userId, siteUrl, { minSeconds: 0 }));
      return new Response(null, { status: 204 });
    }
    // Google 授权完成后跳回这里（浏览器直接打开；用签名的 state 验证是谁）
    if (seg[0] === "google" && seg[1] === "callback") {
      try {
        const link = await handleCallback(url);
        later((async () => {
          await ensureWatch(link.user_id, siteUrl).catch((e) => console.error(e));
          for (const e of await db.listEvents({ from: new Date(Date.now() - 60 * 86400000).toISOString() })) await syncEvent(e.id, siteUrl, link.user_id);
        })());
        return Response.redirect(`${mainUrl(siteUrl)}/?google=ok&email=${encodeURIComponent(link.gmail)}#settings`, 302);
      } catch (err: any) {
        // 用连接者自己的语言显示错误
        const uid = Number((url.searchParams.get("state") || "").split(".")[1]);
        const u = uid ? await db.getUser(uid).catch(() => null) : null;
        const msg = tr(String(err?.message || err), normLang(u?.lang));
        return Response.redirect(`${mainUrl(siteUrl)}/?google_error=${encodeURIComponent(msg)}#settings`, 302);
      }
    }

    // ---------- 以下都要登录 ----------
    const me = await currentUser(req, url);
    const who = me.name;
    if (!req.headers.get("x-lang")) lang = normLang(me.lang);
    const r = seg[0];
    // 没有 WhatsApp 权限 → 忽略客户电话 / 讯息 / 自动发送的修改
    const eventInput = async () => {
      const b = await body();
      if (!canWhatsApp(me)) { delete b.customer_phone; delete b.customer_note; delete b.customer_auto; delete b.customer_name; delete b.customer_send_at; }
      return b;
    };
    const eventDetail = async (eid: number) => {
      const e = await db.getEvent(eid);
      if (!e) notFound();
      const g = await db.getEventGoogle(eid, me.id);
      const { timezone } = await getSettings();
      return { ...e, google: g ? { synced_at: g.synced_at, error: g.error } : null, feed: await db.eventFeed(eid),
        customer_send_at: e.start ? sendTimeFor(e, timezone).toISOString() : null, customer_send_custom: !!e.customer_send_at,
        customer_error: e.customer_error ? tr(e.customer_error, lang) : null };
    };

    if (r === "auth") {
      if (seg[1] === "me" && method === "GET") {
        const link = await db.getGoogleLink(me.id);
        return Response.json({ ...publicUser(me), google: link ? { gmail: link.gmail, calendarName: link.calendar_name || desc(normLang(me.lang), "calendar") } : null });
      }
      if (seg[1] === "me" && method === "PATCH") {
        const b = await body();
        const out: any = { ...publicUser(me) };
        if (b.name !== undefined) {
          const name = String(b.name || "").trim().slice(0, 40);
          if (!name) throw new Error("请输入名字");
          await db.setUserName(me.id, name);
          await db.ensureMember(name);
          out.name = name;
        }
        if (b.lang !== undefined && LANG_CODES.includes(b.lang)) {
          await db.setUserLang(me.id, b.lang);
          out.lang = b.lang;
          // 换语言 → 我的 Google 日历说明也换语言
          if (await db.getGoogleLink(me.id)) later((async () => {
            for (const e of await db.listEvents({ from: new Date(Date.now() - 60 * 86400000).toISOString() })) await syncEvent(e.id, siteUrl, me.id);
          })());
        }
        return Response.json(out);
      }
      if (seg[1] === "password" && method === "POST") return Response.json(await changePassword(me, await body()));
    }

    if (r === "config" && method === "GET") {
      const s = await getSettings();
      return Response.json({ claude: claudeEnabled(), timezone: s.timezone, labels: db.LABELS, labelNames: s.labelNames || {}, waDefault: s.waDefault || "", googleLoginReady: !!clientCredentials(), whatsapp: !!waConfig(), siteUrl: mainUrl(siteUrl), googleRedirectUri: redirectUri() });
    }

    // ---------- 行程 ----------
    if (r === "events") {
      if (!seg[1]) {
        if (method === "GET") return Response.json(await db.listEvents(Object.fromEntries(url.searchParams)));
        if (method === "POST") { const e = await db.createEvent(await eventInput(), who); sync(e.id); return Response.json(e); }
      }
      // WhatsApp Schedule：已发送的讯息从清单删掉
      if (seg[2] === "wa-hide" && method === "POST") {
        if (!canWhatsApp(me)) throw new HttpError(403, "没有权限");
        if (!(await db.hideCustomerMessage(id))) throw new HttpError(400, "还没发送的讯息不能删除");
        return Response.json({ ok: true });
      }
      // 任务清单：打勾完成（只在 App 里）
      if (seg[2] === "done" && method === "POST") {
        if (!(await db.setEventDone(id, !!(await body()).done, who))) notFound();
        return Response.json(await db.getEvent(id));
      }
      // 在时间线发文：文字 + 照片（可只有其中一个）
      if (seg[2] === "posts" && method === "POST") {
        if (!(await db.getEvent(id))) notFound();
        const form = await req.formData();
        const text = String(form.get("text") || "").trim();
        const files = form.getAll("photos") as File[];
        if (!text && !files.length) throw new Error("请输入文字或选择照片");
        if (text) await db.addComment({ event_id: id, author: who, body: text });
        await savePhotos(files, id, who);
        sync(id);
        return Response.json(await eventDetail(id));
      }
      if (seg[2] === "sync" && method === "POST") return Response.json(await syncEvent(id, siteUrl, me.id));
      // 立即用 WhatsApp 发讯息给客户
      if (seg[2] === "customer-send" && method === "POST") {
        if (!canWhatsApp(me)) throw new HttpError(403, "只有管理员允许的帐号可以发送 WhatsApp");
        await sendCustomerMessage(id, { force: true, author: who });
        return Response.json(await eventDetail(id));
      }
      if (!seg[2]) {
        if (method === "GET") return Response.json(await eventDetail(id));
        if (method === "PATCH") { const e = await db.updateEvent(id, await eventInput(), who); if (!e) notFound(); sync(id); return Response.json(e); }
        if (method === "DELETE") {
          const photos = await db.listPhotos(id);
          const mappings = await db.listEventGoogle(id);
          const ok = await db.deleteEvent(id);
          if (ok) {
            later(Promise.all(photos.map((p: any) => deletePhotoData(p.blob_key))));
            later(deleteGoogleEvents(mappings as any));
          }
          return Response.json({ ok });
        }
      }
    }

    // ---------- 照片 ----------
    if (r === "photos") {
      const p = await db.getPhoto(id);
      if (!p) notFound();
      if (seg[2] === "file" && method === "GET") {
        const data = await getPhotoData(p.blob_key);
        if (!data) notFound();
        return new Response(data, { headers: { "Content-Type": p.mime, "Cache-Control": "private, max-age=86400" } });
      }
      if (seg[2] === "comments") {
        if (method === "GET") return Response.json(await db.listComments({ photo_id: id }));
        if (method === "POST") { const c = await db.addComment({ photo_id: id, author: who, body: (await body()).body }); sync(p.event_id); return Response.json(c); }
      }
      if (!seg[2] && method === "DELETE") {
        const ok = await db.deletePhoto(id);
        later(deletePhotoData(p.blob_key));
        sync(p.event_id);
        return Response.json({ ok });
      }
    }

    if (r === "comments" && method === "DELETE") {
      const c = await db.getComment(id);
      const ok = await db.deleteComment(id);
      if (c) sync(c.event_id);
      return Response.json({ ok });
    }

    // ---------- WhatsApp 行程摘要（管理员设定） ----------
    if (r === "digest") {
      if (!isAdmin(me)) throw new HttpError(403, "只有管理员可以设定");
      const cur = (await getSettings()).digest || { mode: "off", hour: 8, phones: [] };
      if (!seg[1] && method === "GET") {
        const want = url.searchParams.get("preview") || (cur.mode === "date" ? cur.date : cur.mode) || ""; // 预览还没保存的选择
        const isDate = /^\d{4}-\d{2}-\d{2}$/.test(want);
        return Response.json({ ...cur, preview: await buildDigest(want === "weekly" ? "weekly" : "daily", new Date(), isDate ? want : undefined) });
      }
      if (!seg[1] && method === "PUT") {
        const b = await body();
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || "")) ? String(b.date) : "";
        const mode = date ? "date" : ["off", "daily", "weekly"].includes(b.mode) ? b.mode : "off";
        const hour = Math.min(23, Math.max(0, Math.floor(Number(b.hour) || 8)));
        const phones = String(b.phones ?? "").split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean).slice(0, 20);
        const digest = { mode, hour, phones, date, lastSent: date !== cur.date ? undefined : cur.lastSent };
        await saveSettings({ digest });
        return Response.json({ ...digest, preview: await buildDigest(mode === "weekly" ? "weekly" : "daily", new Date(), date || undefined) });
      }
    }

    // ---------- 颜色标签的名称（所有人共用） ----------
    if (r === "labels" && seg[1] && method === "PUT") {
      const id = seg[1];
      if (!db.LABELS[id]) notFound();
      const name = String((await body()).name ?? "").trim().slice(0, 30);
      const names = { ...((await getSettings()).labelNames || {}) };
      if (name) names[id] = name; else delete names[id];
      await saveSettings({ labelNames: names });
      return Response.json({ labelNames: names });
    }

    // ---------- 成员 ----------
    if (r === "members") {
      if (!seg[1]) {
        if (method === "GET") return Response.json(await db.listMembers());
        if (method === "POST") return Response.json(await db.createMember(await body()));
      }
      if (method === "PATCH") { const m = await db.updateMember(id, await body()); if (!m) notFound(); return Response.json(m); }
      if (method === "DELETE") return Response.json({ ok: await db.deleteMember(id) });
    }

    // ---------- 我的 Google 日历 ----------
    if (r === "google") {
      if (seg[1] === "connect" && method === "POST") return Response.json({ url: await authUrl(siteUrl, me.id, String((await body()).gmail || me.email)) });
      if (seg[1] === "disconnect" && method === "POST") { await disconnect(me.id); return Response.json({ ok: true }); }
      // 我的 Google「我的日历」清单，和每个日历是否同步（勾选）
      if (seg[1] === "calendars" && !seg[2] && method === "GET") return Response.json(await listSyncCalendars(me.id));
      if (seg[1] === "calendars" && seg[2] && method === "PUT") {
        const r = await setCalendarEnabled(me.id, decodeURIComponent(seg[2]), !!(await body()).enabled);
        later(ensureWatch(me.id, siteUrl));
        return Response.json(r);
      }
      // 改成和另一个 Google 日历双向同步（例如「拍摄」）
      if (seg[1] === "sync-calendar" && method === "POST") {
        const r = await switchSyncCalendar(me.id, String((await body()).calendarId || ""));
        later(ensureWatch(me.id, siteUrl));
        return Response.json(r);
      }
      // 从我的 Google「共享日历」读回变更（打开 App 时会呼叫；1 分钟内只读一次）
      if (seg[1] === "pull" && method === "POST") {
        if (!(await db.getGoogleLink(me.id))) return Response.json({ skipped: true });
        const force = !!(await body()).force; // 切换日历后的第一次完整读取：网页会连续呼叫直到 done
        later(ensureWatch(me.id, siteUrl)); // 确保 Google 有变更会马上通知（已开通就不做事）
        later(retryFailedSyncs(siteUrl, me.id)); // 之前同步失败的行程自动再试
        return Response.json(await pullFromGoogle(me.id, siteUrl, { minSeconds: force ? 0 : 15 }));
      }
      if (seg[1] === "sync-all" && method === "POST") {
        if (!(await db.getGoogleLink(me.id))) throw new Error("你还没连接 Google 日历");
        // 同步最近 60 天到未来 1 年的行程（每次最多约 45 秒，没做完可再按一次）
        const from = new Date(Date.now() - 60 * 86400000).toISOString(), to = new Date(Date.now() + 365 * 86400000).toISOString();
        const events = await db.listEvents({ from, to });
        const deadline = Date.now() + 45_000;
        let ok = 0, failed = 0, lastError = "";
        for (const e of events) {
          if (Date.now() > deadline) break;
          // 只补上 Google 还没有的（已经同步好的不重写，避免改掉 Google 上的资料）
          const m: any = await db.getEventGoogle(e.id, me.id);
          if (m && !m.error) { ok++; continue; }
          const res: any = await syncEvent(e.id, siteUrl, me.id);
          if (res.ok) ok++; else if (!res.skipped) { failed++; lastError = res.error; }
        }
        return Response.json({ total: events.length, ok, failed, lastError, done: ok + failed >= events.length });
      }
    }

    // WhatsApp 这个月用了几则（所有人都看得到）
    if (r === "whatsapp" && seg[1] === "usage" && method === "GET") return Response.json(await waUsage());

    // ---------- 管理员：谁可以发 WhatsApp ----------
    if (r === "admin") {
      if (!isAdmin(me)) throw new HttpError(403, "只有管理员可以设定");
      // 给客户的讯息：自己写的开头 / 结尾
      // 新行程「给客户的讯息」的默认内容
      if (seg[1] === "wa-text" && method === "GET") return Response.json({ text: (await getSettings()).waDefault || "" });
      if (seg[1] === "wa-text" && method === "PUT") {
        await saveSettings({ waDefault: String((await body()).text ?? "").slice(0, 2000), waIntro: "", waOutro: "" });
        return Response.json({ ok: true });
      }
      // 管理员名单：固定的（Supabase 密钥）＋ App 里加的
      if (seg[1] === "admins" && method === "GET") return Response.json({ fixed: fixedAdmins(), extra: (await getSettings()).adminEmails || [] });
      if (seg[1] === "admins" && method === "PUT") {
        const emails = [...new Set(String((await body()).emails ?? "").toLowerCase().split(/[\s,;]+/).map((x) => x.trim()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))]
          .filter((x) => !fixedAdmins().includes(x)).slice(0, 20);
        await saveSettings({ adminEmails: emails });
        return Response.json({ fixed: fixedAdmins(), extra: emails });
      }
      // 每个月上限（例如 Kapso 免费方案）；0 或空 = 不限
      if (seg[1] === "wa-limit" && method === "PUT") {
        const n = Math.floor(Number((await body()).limit) || 0);
        await saveSettings({ waLimit: n > 0 ? n : null });
        return Response.json(await waUsage());
      }
      if (seg[1] === "users" && !seg[2] && method === "GET")
        return Response.json((await db.listUsers()).map((u: any) => ({ id: u.id, email: u.email, name: u.name, admin: isAdmin(u), can_whatsapp: canWhatsApp(u) })));
      if (seg[1] === "users" && seg[2] && method === "PATCH") {
        if (!(await db.setUserWhatsApp(Number(seg[2]), !!(await body()).can_whatsapp))) notFound();
        return Response.json({ ok: true });
      }
    }

    // ---------- 设置 ----------
    if (r === "settings") {
      if (method === "GET" && !seg[1]) {
        const s = await getSettings();
        return Response.json({ timezone: s.timezone, icsUrl: `${apiBase()}/api/cal/${await sign("ics")}.ics?lang=${encodeURIComponent(normLang(me.lang))}` });
      }
      if (seg[1] === "timezone" && method === "PUT") {
        const tz = String((await body()).timezone || "");
        try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { throw new Error("无效的时区"); }
        await saveSettings({ timezone: tz });
        return Response.json({ ok: true, timezone: tz });
      }
    }

    // ---------- Claude 助手 ----------
    if (r === "chat" && method === "POST") {
      const form = await req.formData();
      const history = JSON.parse(String(form.get("history") || "[]"));
      const saved = await savePhotos(form.getAll("photos") as File[], null, who);
      const { timezone } = await getSettings();
      const reply = await chat(history, String(form.get("message") || ""),
        saved.map((p: any) => ({ id: p.id, mime: p.mime, data: Buffer.from(p._buf).toString("base64") })), timezone, who, lang,
        { changed: (eid) => sync(eid), deleted: (m) => later(deleteGoogleEvents(m)), canWhatsApp: canWhatsApp(me) });
      return Response.json({ reply, photos: strip(saved) });
    }

    return notFound();
  } catch (err: any) {
    const status = err instanceof HttpError || err instanceof AuthError ? err.status : 400;
    if (!(err instanceof HttpError) && !(err instanceof AuthError)) console.error(err);
    return Response.json({ error: tr(String(err?.message || err), lang) }, { status });
  }
}

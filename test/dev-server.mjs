// 本地测试用：本地 Postgres + 本地 Blobs + 模拟 Google 日历 API，执行 Netlify 函数
// 用法：node test/dev-server.mjs   （只用于测试，不会部署）
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { NetlifyDB } from "@netlify/database-dev";
import { BlobsServer } from "@netlify/blobs/server";

const PORT = Number(process.env.PORT || 8888);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmp = fs.mkdtempSync("/tmp/fc-test-");

// 1) 资料库
const pg = new NetlifyDB({ logger: () => {} });
process.env.TEST_DB_URL = await pg.start();
console.log("migrations:", await pg.applyMigrations(path.join(root, "netlify/database/migrations")));

// 2) Blobs
const blobs = new BlobsServer({ directory: tmp, token: "test-token" });
const { port: bport } = await blobs.start();
globalThis.netlifyBlobsContext = Buffer.from(JSON.stringify({
  siteID: "local-site", token: "test-token", edgeURL: `http://localhost:${bport}`, uncachedEdgeURL: `http://localhost:${bport}`,
})).toString("base64");

// 3) 模拟 Google（OAuth 登录 + token + Calendar API），记录收到的请求
process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
const googleLog = [];
const gEvents = new Map(); // "calendarId|eventId" → 活动
const gCalendars = new Map();
const gWatches = new Map(); // calendarId → [{id, token, address, resourceId}]
const notifyWatchers = (cal) => Promise.all((gWatches.get(cal) || []).map((w) => fetch(w.address, { method: "POST", headers: { "x-goog-channel-id": w.id, "x-goog-channel-token": w.token, "x-goog-resource-state": "exists" } }).catch(() => {})));
let gSeq = 0;
const stamp = (e) => ({ ...e, seq: ++gSeq, etag: `"e${gSeq}"`, updated: new Date().toISOString() });
// 模拟 tlwcalender 帐号里的「拍摄」日历（从 TimeTree 来的资料）
gCalendars.set("paishe@group.calendar.google.com", { summary: "拍摄" });
gCalendars.set("me@gmail.com", { summary: "me@gmail.com", primary: true });
const P = (id, o) => gEvents.set("paishe@group.calendar.google.com|" + id, stamp({ id, status: "confirmed", ...o }));
P("tt1", { summary: "1205 PW (wenfeng ruyin) Charles & Chris", description: "wenfeng + ruyin", start: { date: "2027-01-02" }, end: { date: "2027-01-03" } });
P("tt2", { summary: "6960 选礼服 (Jess) SY & Lean", colorId: "4", start: { dateTime: "2027-01-02T11:30:00+08:00" }, end: { dateTime: "2027-01-02T13:30:00+08:00" } });
P("tt3", { summary: "6960 PW+MTV SY & Lean", description: "有mtv 不要换摄影师 ⚠️<br><br>📷 照片：<a href=\"https://drive.google.com/x\">https://drive.google.com/x</a>", start: { date: "2027-01-03" }, end: { date: "2027-01-05" }, attachments: [{ fileUrl: "https://drive.google.com/x", title: "6960 照片" }] });
P("tt4", { summary: "已取消的", status: "cancelled" });
const google = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const u = new URL(req.url, "http://x");
    googleLog.push({ method: req.method, url: req.url, body: b ? (u.pathname === "/token" ? Object.fromEntries(new URLSearchParams(b)) : JSON.parse(b)) : null });
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (u.pathname === "/auth") { // 模拟 Google 同意画面：直接跳回 App
      const back = new URL(u.searchParams.get("redirect_uri"));
      // 模拟用户在 Google 画面选的帐号：默认是 login_hint，测试可用 &pick= 改成别的
      const picked = u.searchParams.get("pick") || u.searchParams.get("login_hint");
      back.searchParams.set("code", "code-" + Buffer.from(picked).toString("base64url")); back.searchParams.set("state", u.searchParams.get("state"));
      res.writeHead(302, { location: back.toString() }); return res.end();
    }
    if (u.pathname === "/token") {
      const p = new URLSearchParams(b);
      if (p.get("client_secret") !== "test-client-secret") return send(401, { error: "invalid_client" });
      if (p.get("grant_type") === "authorization_code" && (p.get("code") || "").startsWith("code-")) {
        const email = Buffer.from(p.get("code").slice(5), "base64url").toString();
        const idToken = "x." + Buffer.from(JSON.stringify({ email })).toString("base64url") + ".y";
        return send(200, { access_token: "tok-123", refresh_token: "refresh-" + email, expires_in: 3600, scope: "openid email https://www.googleapis.com/auth/calendar", id_token: idToken });
      }
      if (p.get("grant_type") === "refresh_token" && (p.get("refresh_token") || "").startsWith("refresh-")) return send(200, { access_token: "tok-123", expires_in: 3600 });
      return send(400, { error: "invalid_grant" });
    }
    if (req.headers.authorization !== "Bearer tok-123") return send(401, { error: { message: "no auth" } });
    if (u.pathname === "/calendar/v3/users/me/calendarList") {
      return send(200, { items: [...gCalendars.entries()].map(([id, c]) => ({ id, summary: c.summary, primary: !!c.primary, accessRole: "owner" })) });
    }
    if (u.pathname.startsWith("/calendar/v3/users/me/calendarList/")) {
      const id = decodeURIComponent(u.pathname.split("/").pop());
      return gCalendars.has(id) ? send(200, { id, summary: gCalendars.get(id).summary, accessRole: "owner" }) : send(404, { error: { message: "Not Found" } });
    }
    if (u.pathname === "/calendar/v3/calendars" && req.method === "POST") {
      const id = "cal" + (gCalendars.size + 1) + "@group.calendar.google.com"; gCalendars.set(id, JSON.parse(b)); return send(200, { id });
    }
    if (u.pathname === "/calendar/v3/channels/stop") {
      const { id } = JSON.parse(b); for (const [c, ws] of gWatches) gWatches.set(c, ws.filter((w) => w.id !== id)); res.writeHead(204); return res.end();
    }
    const wm = u.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events\/watch$/);
    if (wm && req.method === "POST") {
      const cal = decodeURIComponent(wm[1]), w = JSON.parse(b), resourceId = "res-" + w.id;
      gWatches.set(cal, [...(gWatches.get(cal) || []), { ...w, resourceId }]);
      return send(200, { id: w.id, resourceId, expiration: String(Date.now() + 30 * 86400000) });
    }
    const m = u.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)(\/events(?:\/([^/?]+))?)?/);
    if (!m) return send(404, { error: { message: "nope" } });
    const cal = decodeURIComponent(m[1]);
    if (!gCalendars.has(cal)) return send(404, { error: { message: "Not Found" } });
    if (!m[2]) return send(200, { id: cal, summary: gCalendars.get(cal).summary });
    const eid = m[3];
    const key = (id) => cal + "|" + id;
    if (req.method === "GET" && !eid) { // 列出活动：支援分页、syncToken、showDeleted
      const all = [...gEvents.entries()].filter(([k]) => k.startsWith(cal + "|")).map(([, e]) => e).sort((a, z) => a.seq - z.seq);
      const since = u.searchParams.get("syncToken") ? Number(u.searchParams.get("syncToken")) : null;
      let list = since != null ? all.filter((e) => e.seq > since) : all.filter((e) => u.searchParams.get("showDeleted") === "true" || e.status !== "cancelled");
      if (since == null && u.searchParams.get("timeMin")) list = list.filter((e) => e.status !== "cancelled");
      const max = Number(u.searchParams.get("maxResults") || 250), off = Number(u.searchParams.get("pageToken") || 0);
      const page = list.slice(off, off + max);
      const more = off + max < list.length;
      return send(200, { items: page, ...(more ? { nextPageToken: String(off + max) } : { nextSyncToken: String(gSeq) }) });
    }
    if (req.method === "POST") { const ev = JSON.parse(b); const id = ev.id || "g" + (++gSeq); if (gEvents.has(key(id)) && gEvents.get(key(id)).status !== "cancelled") return send(409, { error: { message: "duplicate" } }); const st = stamp({ ...ev, id }); gEvents.set(key(id), st); return send(200, st); }
    if (req.method === "PUT") { if (!gEvents.has(key(eid))) return send(404, { error: { message: "gone" } }); const st = stamp({ ...JSON.parse(b), id: eid }); gEvents.set(key(eid), st); return send(200, st); }
    if (req.method === "DELETE") { const e = gEvents.get(key(eid)); if (e) gEvents.set(key(eid), stamp({ id: eid, status: "cancelled" })); res.writeHead(204); return res.end(); }
    send(400, {});
  });
}).listen(0);
const gport = google.address().port;
process.env.GOOGLE_API_BASE = `http://localhost:${gport}`;
process.env.GOOGLE_TOKEN_URL = `http://localhost:${gport}/token`;
process.env.GOOGLE_AUTH_URL = `http://localhost:${gport}/auth`;

// 3b) 模拟 WhatsApp Cloud API（记录收到的讯息；电话 60111 开头的会回错误）
const waLog = [];
const wa = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const body = JSON.parse(b || "{}"); waLog.push({ url: req.url, auth: req.headers.authorization || "X-API-Key " + req.headers["x-api-key"], body });
    res.writeHead(body.to?.startsWith("60111") ? 400 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(body.to?.startsWith("60111") ? { error: { message: "Recipient phone number not in allowed list", error_data: { details: "test" } } } : { messages: [{ id: "wamid.test" + waLog.length }] }));
  });
}).listen(0);
if (!process.env.NO_WA) {
  if (process.env.TEST_KAPSO) process.env.KAPSO_API_KEY = "kapso-key"; else process.env.WHATSAPP_TOKEN = "wa-token";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "12345";
  process.env.WHATSAPP_API_BASE = `http://localhost:${wa.address().port}`;
}

// 4) 载入函数
const api = (await import(path.join(root, "netlify/functions/api.mts"))).default;
const photoLink = (await import(path.join(root, "netlify/functions/photo-link.mts"))).default;
const calFeed = (await import(path.join(root, "netlify/functions/calendar-feed.mts"))).default;
const waLib = await import(path.join(root, "netlify/lib/whatsapp.mts"));

const pending = [];
const ctx = (params = {}) => ({ params, waitUntil: (p) => pending.push(p) });
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
  let response;
  try {
    if (url.pathname.startsWith("/api/")) response = await api(request, ctx());
    else if (url.pathname.startsWith("/p/")) response = await photoLink(request, ctx({ id: url.pathname.split("/")[2] }));
    else if (url.pathname.startsWith("/cal/")) response = await calFeed(request, ctx({ file: url.pathname.split("/")[2] }));
    else if (url.pathname === "/__test/google") { await Promise.all(pending.splice(0)); response = Response.json({ log: googleLog, events: Object.fromEntries(gEvents) }); }
    else if (url.pathname === "/__test/gedit") {
      const q = Object.fromEntries(url.searchParams);
      const calId = q.cal || [...gCalendars.keys()].find((k) => gCalendars.get(k).summary === "共享日历" || gCalendars.get(k).summary === "Shared Calendar" || gCalendars.get(k).summary === "Kalendar Bersama");
      const k = calId + "|" + q.id;
      if (q.op === "create") gEvents.set(calId + "|" + q.id, stamp({ id: q.id, status: "confirmed", summary: q.title, description: q.desc || "", start: { dateTime: q.start }, end: { dateTime: q.end } }));
      if (q.op === "dump") { response = Response.json([...gEvents.entries()].filter(([x]) => x.startsWith(calId + "|")).map(([, e]) => ({ id: e.id, status: e.status, summary: e.summary }))); }
      if (q.op === "rename") { const e = gEvents.get(k); gEvents.set(k, stamp({ ...e, summary: q.title, colorId: q.color })); }
      if (q.op === "delete") gEvents.set(k, stamp({ id: q.id, status: "cancelled" }));
      if (q.op !== "dump" && q.notify !== "0") await notifyWatchers(calId);
      if (q.op === "watches") response = Response.json(Object.fromEntries(gWatches));
      response ??= Response.json({ ok: true, calId, ids: [...gEvents.keys()].filter((x) => x.startsWith(calId + "|")) });
    }
    else if (url.pathname === "/__test/wa-run") response = Response.json(await waLib.sendDueCustomerMessages());
    else if (url.pathname === "/__test/wa") response = Response.json(waLog);
    else if (url.pathname === "/__test/flush") { await Promise.all(pending.splice(0)); response = Response.json({ ok: true }); }
    else {
      const f = path.join(root, "public", url.pathname === "/" ? "index.html" : url.pathname);
      response = fs.existsSync(f) ? new Response(fs.readFileSync(f), { headers: { "content-type": MIME[path.extname(f)] || "application/octet-stream" } }) : new Response("404", { status: 404 });
    }
  } catch (e) { console.error(e); response = new Response(String(e), { status: 500 }); }
  const hdrs = Object.fromEntries(response.headers);
  if (response.status >= 300 && response.status < 400 && !hdrs.location) hdrs.location = response.headers.get("location");
  res.writeHead(response.status, hdrs);
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, () => console.log(`ready http://localhost:${PORT}`));

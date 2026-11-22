// 资料层：Netlify Database（Postgres）
import { getDatabase } from "@netlify/database";
import { env } from "./env.mts";

let _db: ReturnType<typeof getDatabase> | null = null;
export function database() {
  if (!_db) {
    const cs = env("TEST_DB_URL"); // 只在本地测试时使用
    _db = cs ? getDatabase({ connectionString: cs }) : getDatabase();
  }
  return _db;
}
// 统一用连接池执行参数化查询（$1, $2 …）
async function q(text: string, params: any[] = []): Promise<any[]> {
  const r: any = await (database().pool as any).query(text, params);
  return r.rows;
}
// sql`... ${value} ...` 自动变成参数化查询，防止 SQL 注入
const sql = (strings: TemplateStringsArray, ...values: any[]) =>
  q(strings.reduce((acc, s, i) => acc + s + (i < values.length ? "$" + (i + 1) : ""), ""), values);

const iso = (v: any) => (v == null || v === "" ? null : new Date(v).toISOString());
function toIso(v: any) {
  if (v == null || v === "") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`无效时间: ${v}`);
  return d.toISOString();
}
const clean = (s: any, max = 2000) => (s == null ? null : String(s).trim().slice(0, max) || null);

// Google 日历的 11 种活动颜色（label 存 Google 的 colorId）
export const LABELS: Record<string, { name: string; hex: string }> = {
  "11": { name: "番茄红", hex: "#d50000" }, "4": { name: "火鹤粉", hex: "#e67c73" }, "6": { name: "橘子", hex: "#f4511e" },
  "5": { name: "香蕉黄", hex: "#f6bf26" }, "2": { name: "鼠尾草", hex: "#33b679" }, "10": { name: "罗勒绿", hex: "#0b8043" },
  "7": { name: "孔雀蓝", hex: "#039be5" }, "9": { name: "蓝莓", hex: "#3f51b5" }, "1": { name: "薰衣草", hex: "#7986cb" },
  "3": { name: "葡萄紫", hex: "#8e24aa" }, "8": { name: "石墨灰", hex: "#616161" },
};

function outEvent(e: any) {
  if (!e) return e;
  return {
    ...e, start: iso(e.start), end: iso(e.end), created_at: iso(e.created_at),
    all_day: e.all_day ? 1 : 0, remind: e.remind ? 1 : 0,
    customer_auto: e.customer_auto === false ? 0 : 1, customer_sent_at: iso(e.customer_sent_at),
    color: e.label && LABELS[e.label] ? LABELS[e.label].hex : null,
    photo_count: Number(e.photo_count ?? 0), memo_count: Number(e.memo_count ?? 0),
  };
}
const outRow = (r: any) => (r ? { ...r, created_at: iso(r.created_at) } : r);

// ---------- 行程 ----------
const EVENT_COLS = `e.*, m.name AS member_name, m.color AS member_color,
  (SELECT COUNT(*) FROM photos p WHERE p.event_id = e.id)::int AS photo_count,
  (SELECT COUNT(*) FROM comments cm WHERE cm.event_id = e.id AND cm.photo_id IS NULL)::int AS memo_count`;

export async function listEvents({ from, to, q: keyword }: { from?: string; to?: string; q?: string } = {}) {
  const rows = await q(
    `SELECT ${EVENT_COLS} FROM events e LEFT JOIN members m ON m.id = e.member_id
     WHERE ($1::timestamptz IS NULL OR COALESCE(e."end", e.start) >= $1) AND ($2::timestamptz IS NULL OR e.start < $2)
       AND ($3::text IS NULL OR e.title ILIKE '%' || $3 || '%' OR e.notes ILIKE '%' || $3 || '%')
     ORDER BY e.start`,
    [from ? toIso(from) : null, to ? toIso(to) : null, keyword || null],
  );
  return rows.map(outEvent);
}

export async function getEvent(id: number) {
  const rows = await q(`SELECT ${EVENT_COLS} FROM events e LEFT JOIN members m ON m.id = e.member_id WHERE e.id = $1`, [id]);
  return outEvent(rows[0]) ?? null;
}

function checkLabel(label: any) {
  if (label == null || label === "") return null;
  if (!LABELS[String(label)]) throw new Error("无效的颜色标签");
  return String(label);
}

export async function createEvent(e: any, author?: string | null) {
  const title = clean(e.title, 300);
  if (!title) throw new Error("请填写标题");
  const start = toIso(e.start), end = toIso(e.end);
  if (!start) throw new Error("请填写开始时间");
  if (end && end < start) throw new Error("结束时间不能早于开始时间");
  const [r] = await sql`INSERT INTO events (title, start, "end", all_day, notes, label, member_id, remind, created_by, customer_phone, customer_note, customer_auto)
    VALUES (${title}, ${start}, ${end}, ${!!e.all_day}, ${clean(e.notes, 5000)}, ${checkLabel(e.label)},
            ${e.member_id ?? null}, ${e.remind === undefined ? true : !!e.remind}, ${clean(author, 60)},
            ${clean(e.customer_phone, 40)}, ${clean(e.customer_note, 2000)}, ${e.customer_auto === undefined ? true : !!e.customer_auto})
    RETURNING id`;
  await logEvent(r.id, author, "created");
  return getEvent(r.id);
}

// 变更纪录存代码（"updated:title,time"），显示时依各人的语言翻译
const FIELD_CODES: Record<string, string> = { title: "title", start: "time", end: "time", all_day: "time", notes: "notes", label: "label", member_id: "member", remind: "remind",
  customer_phone: "customer", customer_note: "customer", customer_auto: "customer_auto" };

export async function updateEvent(id: number, e: any, author?: string | null) {
  const old = await getEvent(id);
  if (!old) return null;
  const next: any = {
    title: e.title !== undefined ? clean(e.title, 300) : old.title,
    start: e.start !== undefined ? toIso(e.start) : old.start,
    end: e.end !== undefined ? toIso(e.end) : old.end,
    all_day: e.all_day !== undefined ? !!e.all_day : !!old.all_day,
    notes: e.notes !== undefined ? clean(e.notes, 5000) : old.notes,
    label: e.label !== undefined ? checkLabel(e.label) : old.label,
    member_id: e.member_id !== undefined ? e.member_id : old.member_id,
    remind: e.remind !== undefined ? !!e.remind : !!old.remind,
    customer_phone: e.customer_phone !== undefined ? clean(e.customer_phone, 40) : old.customer_phone,
    customer_note: e.customer_note !== undefined ? clean(e.customer_note, 2000) : old.customer_note,
    customer_auto: e.customer_auto !== undefined ? !!e.customer_auto : old.customer_auto !== 0,
  };
  if (!next.title) throw new Error("请填写标题");
  if (!next.start) throw new Error("请填写开始时间");
  if (next.end && next.end < next.start) throw new Error("结束时间不能早于开始时间");
  await sql`UPDATE events SET title = ${next.title}, start = ${next.start}, "end" = ${next.end}, all_day = ${next.all_day},
    notes = ${next.notes}, label = ${next.label}, member_id = ${next.member_id}, remind = ${next.remind},
    customer_phone = ${next.customer_phone}, customer_note = ${next.customer_note}, customer_auto = ${next.customer_auto} WHERE id = ${id}`;
  // 变更纪录：「修改了标题、时间」
  const prev: any = { ...old, all_day: !!old.all_day, remind: !!old.remind, customer_auto: old.customer_auto !== 0 };
  // 电话、讯息或日期改了 → 之后会再发一次新的
  if (next.customer_phone !== old.customer_phone || next.customer_note !== old.customer_note || next.start !== old.start || (next.customer_auto && !prev.customer_auto))
    await sql`UPDATE events SET customer_sent_at = NULL, customer_error = NULL WHERE id = ${id}`;
  const changed = [...new Set(Object.keys(next).filter((k) => (next[k] ?? null) !== (prev[k] ?? null)).map((k) => FIELD_CODES[k]))];
  if (changed.length) await logEvent(id, author, `updated:${changed.join(",")}`);
  return getEvent(id);
}

export async function deleteEvent(id: number) {
  return (await sql`DELETE FROM events WHERE id = ${id} RETURNING id`).length > 0;
}

// ---------- 给客户的 WhatsApp ----------
/** 还没发、开着自动发送、未来 3 天内开始的行程 */
export async function pendingCustomerMessages() {
  return sql`SELECT id, start, customer_phone, customer_note FROM events
    WHERE customer_auto AND customer_sent_at IS NULL AND customer_error IS NULL
      AND COALESCE(customer_phone, '') <> '' AND COALESCE(customer_note, '') <> ''
      AND start > NOW() AND start < NOW() + INTERVAL '3 days'`;
}
/** 抢占发送（避免重复发）；force = 手动「立即发送」 */
export async function claimCustomerSend(id: number, force = false) {
  const r = force
    ? await sql`UPDATE events SET customer_sent_at = NOW(), customer_error = NULL WHERE id = ${id} RETURNING id`
    : await sql`UPDATE events SET customer_sent_at = NOW(), customer_error = NULL WHERE id = ${id} AND customer_sent_at IS NULL AND customer_error IS NULL RETURNING id`;
  return r.length > 0;
}
export async function recordWaSent(eventId: number) {
  await sql`INSERT INTO wa_sent (event_id) VALUES (${eventId})`;
}
export async function countWaSentSince(since: Date) {
  return Number((await sql`SELECT COUNT(*)::int AS n FROM wa_sent WHERE sent_at >= ${since.toISOString()}`)[0]?.n ?? 0);
}
export async function setCustomerError(id: number, error: string) {
  await sql`UPDATE events SET customer_sent_at = NULL, customer_error = ${error} WHERE id = ${id}`;
}

// ---------- 帐号 ----------
export async function listUsers() {
  return sql`SELECT id, email, name, wa_allowed, created_at FROM users ORDER BY created_at`;
}
export async function setUserWhatsApp(id: number, allowed: boolean) {
  return (await sql`UPDATE users SET wa_allowed = ${allowed} WHERE id = ${id} RETURNING id`).length > 0;
}
export async function getUser(id: number) {
  return (await sql`SELECT * FROM users WHERE id = ${id}`)[0] ?? null;
}
export async function getUserByEmail(email: string) {
  return (await sql`SELECT * FROM users WHERE email = ${email}`)[0] ?? null;
}
export async function createUser(u: { email: string; name: string; password_hash: string; lang: string }) {
  return (await sql`INSERT INTO users (email, name, password_hash, lang) VALUES (${u.email}, ${u.name}, ${u.password_hash}, ${u.lang}) RETURNING *`)[0];
}
export async function setUserLang(id: number, lang: string) {
  await sql`UPDATE users SET lang = ${lang} WHERE id = ${id}`;
}
export async function setUserName(id: number, name: string) {
  await sql`UPDATE users SET name = ${name} WHERE id = ${id}`;
}
export async function setUserPassword(id: number, hash: string) {
  await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${id}`;
}
/** 注册时把名字加进「成员」（已有同名就不加） */
export async function ensureMember(name: string) {
  const found = await sql`SELECT id FROM members WHERE LOWER(name) = LOWER(${name})`;
  if (!found.length) await createMember({ name });
}

// ---------- 每个人的 Google 日历连接 ----------
export async function getGoogleLink(userId: number) {
  return (await sql`SELECT * FROM google_links WHERE user_id = ${userId}`)[0] ?? null;
}
export async function listGoogleLinks() {
  return sql`SELECT * FROM google_links ORDER BY user_id`;
}
export async function saveGoogleLink(l: { user_id: number; gmail: string; refresh_token: string; calendar_id: string }) {
  await sql`INSERT INTO google_links (user_id, gmail, refresh_token, calendar_id) VALUES (${l.user_id}, ${l.gmail}, ${l.refresh_token}, ${l.calendar_id})
    ON CONFLICT (user_id) DO UPDATE SET gmail = EXCLUDED.gmail, refresh_token = EXCLUDED.refresh_token, calendar_id = EXCLUDED.calendar_id`;
}
export async function deleteGoogleLink(userId: number) {
  await sql`DELETE FROM event_google WHERE user_id = ${userId}`;
  await sql`DELETE FROM google_links WHERE user_id = ${userId}`;
}
/** 改成同步另一个 Google 日历：换日历、清掉旧的对应和同步位置 */
export async function switchGoogleCalendar(userId: number, calendarId: string, name: string | null) {
  await sql`DELETE FROM event_google WHERE user_id = ${userId}`;
  await sql`UPDATE google_links SET calendar_id = ${calendarId}, calendar_name = ${name}, sync_token = NULL, last_pull_at = NULL, watch_id = NULL, watch_resource = NULL, watch_expires = NULL WHERE user_id = ${userId}`;
}
export async function clearEventGoogle(userId: number) {
  await sql`DELETE FROM event_google WHERE user_id = ${userId}`;
}
export async function getEventGoogle(eventId: number, userId: number) {
  return (await sql`SELECT * FROM event_google WHERE event_id = ${eventId} AND user_id = ${userId}`)[0] ?? null;
}
export async function listEventGoogle(eventId: number) {
  return sql`SELECT * FROM event_google WHERE event_id = ${eventId}`;
}
export async function setEventGoogle(eventId: number, userId: number, f: { google_event_id: string; error?: string | null; etag?: string | null }) {
  await sql`INSERT INTO event_google (event_id, user_id, google_event_id, synced_at, error, etag)
    VALUES (${eventId}, ${userId}, ${f.google_event_id}, ${f.error ? null : new Date().toISOString()}, ${f.error ?? null}, ${f.etag ?? null})
    ON CONFLICT (event_id, user_id) DO UPDATE SET google_event_id = EXCLUDED.google_event_id,
      synced_at = COALESCE(EXCLUDED.synced_at, event_google.synced_at), error = EXCLUDED.error,
      etag = COALESCE(EXCLUDED.etag, event_google.etag)`;
}
export async function findEventGoogle(userId: number, googleEventId: string) {
  return (await sql`SELECT * FROM event_google WHERE user_id = ${userId} AND google_event_id = ${googleEventId}`)[0] ?? null;
}
export async function deleteEventGoogle(eventId: number, userId: number) {
  await sql`DELETE FROM event_google WHERE event_id = ${eventId} AND user_id = ${userId}`;
}
export async function setLinkSync(userId: number, f: { sync_token?: string | null; pulled?: boolean }) {
  if (f.sync_token !== undefined) await sql`UPDATE google_links SET sync_token = ${f.sync_token} WHERE user_id = ${userId}`;
  if (f.pulled) await sql`UPDATE google_links SET last_pull_at = NOW() WHERE user_id = ${userId}`;
}
/** 抢占「从 Google 读取」：距离上次超过 minSeconds 秒才执行（避免同时重复读取） */
export async function claimPull(userId: number, minSeconds: number) {
  const r = await sql`UPDATE google_links SET last_pull_at = NOW()
    WHERE user_id = ${userId} AND (last_pull_at IS NULL OR last_pull_at < NOW() - (${minSeconds} || ' seconds')::interval) RETURNING user_id`;
  return r.length > 0;
}


// Google 推送通知
export async function setWatch(userId: number, w: { id: string | null; resource: string | null; expires: Date | null }) {
  await sql`UPDATE google_links SET watch_id = ${w.id}, watch_resource = ${w.resource}, watch_expires = ${w.expires} WHERE user_id = ${userId}`;
}
// 读取锁：同一个人同一时间只有一个读取在跑；其他通知只标记「要再读一次」
export async function requestPull(userId: number) {
  await sql`UPDATE google_links SET pull_again = TRUE WHERE user_id = ${userId}`;
}
export async function takePullLease(userId: number) {
  const r = await sql`UPDATE google_links SET pull_lease = NOW() + INTERVAL '60 seconds'
    WHERE user_id = ${userId} AND (pull_lease IS NULL OR pull_lease < NOW()) RETURNING user_id`;
  return r.length > 0;
}
export async function clearPullAgain(userId: number) {
  await sql`UPDATE google_links SET pull_again = FALSE WHERE user_id = ${userId}`;
}
/** 没有新通知才放开锁；有新通知回传 false（要再读一次） */
export async function releasePullLease(userId: number, force = false) {
  const r = force
    ? await sql`UPDATE google_links SET pull_lease = NULL WHERE user_id = ${userId} RETURNING user_id`
    : await sql`UPDATE google_links SET pull_lease = NULL WHERE user_id = ${userId} AND pull_again = FALSE RETURNING user_id`;
  return r.length > 0;
}

// ---------- 变更纪录 ----------
export async function logEvent(eventId: number, author: string | null | undefined, action: string) {
  await sql`INSERT INTO event_log (event_id, author, action) VALUES (${eventId}, ${clean(author, 60)}, ${action})`;
}

/** 行程的时间线：留言、照片、变更纪录，按时间排序 */
export async function eventFeed(eventId: number) {
  const [comments, photos, logs] = await Promise.all([
    sql`SELECT id, author, body, created_at FROM comments WHERE event_id = ${eventId} AND photo_id IS NULL`,
    sql`SELECT p.id, p.author, p.caption, p.created_at,
          (SELECT COUNT(*) FROM comments c WHERE c.photo_id = p.id)::int AS comment_count
        FROM photos p WHERE p.event_id = ${eventId}`,
    sql`SELECT id, author, action, created_at FROM event_log WHERE event_id = ${eventId}`,
  ]);
  const items = [
    ...comments.map((c: any) => ({ type: "comment", id: c.id, author: c.author, body: c.body, created_at: iso(c.created_at) })),
    ...photos.map((p: any) => ({ type: "photo", id: p.id, author: p.author, caption: p.caption, comment_count: p.comment_count, created_at: iso(p.created_at) })),
    ...logs.map((l: any) => ({ type: "log", id: l.id, author: l.author, body: l.action, created_at: iso(l.created_at) })),
  ];
  const order: Record<string, number> = { log: 0, comment: 1, photo: 2 };
  return items.sort((a: any, b: any) => a.created_at.localeCompare(b.created_at) || order[a.type] - order[b.type] || a.id - b.id);
}

// ---------- 成员 ----------
const MEMBER_COLORS = ["#4f9d69", "#e07a5f", "#3d85c6", "#b565a7", "#e0a100", "#2a9d8f", "#d1495b", "#6c757d"];
export async function listMembers() {
  return (await sql`SELECT * FROM members ORDER BY id`).map(outRow);
}
export async function getMember(id: number) {
  return outRow((await sql`SELECT * FROM members WHERE id = ${id}`)[0]) ?? null;
}
export async function createMember(m: any) {
  const name = clean(m.name, 40);
  if (!name) throw new Error("请填写名字");
  const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM members`;
  const [r] = await sql`INSERT INTO members (name, color) VALUES (${name}, ${m.color || MEMBER_COLORS[n % MEMBER_COLORS.length]}) RETURNING id`;
  return getMember(r.id);
}
export async function updateMember(id: number, m: any) {
  const old = await getMember(id);
  if (!old) return null;
  const name = m.name !== undefined ? clean(m.name, 40) : old.name;
  if (!name) throw new Error("请填写名字");
  await sql`UPDATE members SET name = ${name}, color = ${m.color || old.color} WHERE id = ${id}`;
  return getMember(id);
}
export async function deleteMember(id: number) {
  return (await sql`DELETE FROM members WHERE id = ${id} RETURNING id`).length > 0;
}

// ---------- 照片 ----------
export async function addPhoto(p: { event_id?: number | null; blob_key: string; mime: string; caption?: string | null; author?: string | null }) {
  const [r] = await sql`INSERT INTO photos (event_id, blob_key, mime, caption, author)
    VALUES (${p.event_id ?? null}, ${p.blob_key}, ${p.mime}, ${clean(p.caption, 500)}, ${clean(p.author, 60)}) RETURNING *`;
  return outRow(r);
}
export async function listPhotos(eventId: number) {
  return (await sql`SELECT p.*, (SELECT COUNT(*) FROM comments c WHERE c.photo_id = p.id)::int AS comment_count
    FROM photos p WHERE p.event_id = ${eventId} ORDER BY p.id`).map(outRow);
}
export async function getPhoto(id: number) {
  return outRow((await sql`SELECT * FROM photos WHERE id = ${id}`)[0]) ?? null;
}
export async function attachPhoto(id: number, eventId: number, caption?: string | null) {
  await sql`UPDATE photos SET event_id = ${eventId}, caption = COALESCE(${clean(caption, 500)}, caption) WHERE id = ${id}`;
}
export async function deletePhoto(id: number) {
  return (await sql`DELETE FROM photos WHERE id = ${id} RETURNING id`).length > 0;
}

// ---------- 留言 / 评论 ----------
export async function listComments({ event_id, photo_id }: { event_id?: number; photo_id?: number }) {
  const rows = photo_id
    ? await sql`SELECT * FROM comments WHERE photo_id = ${photo_id} ORDER BY id`
    : await sql`SELECT * FROM comments WHERE event_id = ${event_id} AND photo_id IS NULL ORDER BY id`;
  return rows.map(outRow);
}
export async function addComment({ event_id, photo_id, author, body }: any) {
  const text = clean(body, 5000);
  if (!text) throw new Error("内容不能为空");
  if (photo_id) {
    const p = await getPhoto(photo_id);
    if (!p) throw new Error("找不到照片");
    event_id = p.event_id;
  }
  const [r] = await sql`INSERT INTO comments (event_id, photo_id, author, body)
    VALUES (${event_id ?? null}, ${photo_id ?? null}, ${clean(author, 60)}, ${text}) RETURNING *`;
  return outRow(r);
}
export async function getComment(id: number) {
  return outRow((await sql`SELECT * FROM comments WHERE id = ${id}`)[0]) ?? null;
}
export async function deleteComment(id: number) {
  return (await sql`DELETE FROM comments WHERE id = ${id} RETURNING id`).length > 0;
}

// ===================== Shared Calendar / 共享日历 =====================
import { LANGS, t, setLang, getLang, locale, applyI18n } from "./i18n.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toLocalInput = (iso) => { if (!iso) return ""; const d = new Date(iso); return `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
const fmtTime = (iso) => new Date(iso).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
const fmtDateTime = (iso) => new Date(iso).toLocaleString(locale(), { month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
const fmtLongDate = (d) => d.toLocaleDateString(locale(), { year: "numeric", month: "long", day: "numeric", weekday: "short" });
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const DEFAULT_COLOR = "#2d5fa8";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 密码：至少 6 个字，且至少 1 个特殊符号（不是字母、数字、空白）
const passwordOk = (pw) => pw.length >= 6 && /[^\p{L}\p{N}\s]/u.test(pw);

// ---------- API ----------
// 后端（Supabase 函数）的网址在 config.js 设定；空白 = 同一个网站
const API_BASE = String(window.APP_CONFIG?.apiBase || "").replace(/\/$/, "");
const token = () => store.get("token") || "";
const myName = () => state.me?.name || "";
async function api(path, opts = {}) {
  const headers = { "x-lang": getLang(), ...(token() ? { Authorization: `Bearer ${token()}` } : {}), ...(opts.headers || {}) };
  let body = opts.body;
  if (body && !(body instanceof FormData)) { headers["Content-Type"] = "application/json"; body = JSON.stringify(body); }
  const res = await fetch(API_BASE + path, { ...opts, body, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/api/auth/login") && !path.startsWith("/api/auth/signup") && !path.startsWith("/api/auth/password")) {
    showAuth(data.error);
    throw new Error(data.error || "401");
  }
  if (!res.ok) throw new Error(data.error || res.statusText || `Server error ${res.status}`);
  return data;
}
const photoUrl = (id) => `${API_BASE}/api/photos/${id}/file?t=${encodeURIComponent(token())}`;

// 上传前在手机上缩小照片（最长边 1600px，JPEG），上传更快、也不会超过服务器上限
async function shrinkForUpload(file) {
  if (!/^image\//i.test(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    if (s === 1 && file.size < 1.5 * 1024 * 1024 && file.type === "image/jpeg") return file;
    const cv = document.createElement("canvas"); cv.width = Math.round(bmp.width * s); cv.height = Math.round(bmp.height * s);
    cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
    const blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.85));
    return blob ? new File([blob], (file.name || "photo").replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
  } catch { return file; }
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2800);
}
function askConfirm(message, okText) {
  return new Promise((resolve) => {
    const d = $("#confirmDialog");
    $("#confirmText").textContent = message;
    $("#confirmOk").textContent = okText || t("ok");
    const done = (v) => { d.close(); resolve(v); };
    $("#confirmOk").onclick = () => done(true);
    $("#confirmCancel").onclick = () => done(false);
    d.oncancel = () => resolve(false);
    d.showModal();
  });
}
// Enter 送出（Shift+Enter 换行）
function enterToSend(input, send) {
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); send(); }
  });
}
function avatar(name) {
  const n = name || "?";
  const m = state.members.find((x) => x.name === n);
  if (m?.emoji) return `<span class="avatar emoji" style="--ring:${esc(m.color || "#4a7be0")}">${esc(m.emoji)}</span>`;
  let color = m?.color;
  if (!color) { let h = 0; for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) % 360; color = n === "Claude" ? "#c47a3d" : `hsl(${h} 45% 48%)`; }
  return `<span class="avatar" style="background:${esc(color)}">${esc(n.slice(0, 1))}</span>`;
}
// 颜色标签的显示顺序：由浅到深，每个颜色只有一个
const LABEL_ORDER = ["5", "6", "4", "2", "7", "1", "10", "9", "11", "3", "8"];
const orderedLabels = () => LABEL_ORDER.filter((id) => state.labels[id]).map((id) => [id, state.labels[id]]);
const labelName = (id) => state.labelNames?.[id] || t(`label_${id}`);
const author = (n) => n || t("anonymous");

// ---------- 状态 ----------
const state = {
  month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  selected: new Date(),
  events: [], members: [], labels: {}, config: {}, chatHistory: [], me: null, view: "calendar",
};

// ---------- 语言 ----------
function fillLangSelects() {
  for (const sel of [$("#authLang"), $("#langSelect")]) {
    sel.innerHTML = LANGS.map((l) => `<option value="${l.code}" ${l.code === getLang() ? "selected" : ""}>${esc(l.name)}</option>`).join("");
  }
}
function renderWeekdays() {
  const base = new Date(2023, 0, 1); // 星期日
  $("#weekdays").innerHTML = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(base); d.setDate(1 + i);
    return `<span>${esc(d.toLocaleDateString(locale(), { weekday: "short" }))}</span>`;
  }).join("");
}
/** 换语言后，重画所有动态内容 */
function rerenderAll() {
  applyI18n(document);
  fillLangSelects();
  renderWeekdays();
  setAuthMode(authMode);
  if (!document.body.classList.contains("locked")) {
    showView(state.view);
    if (state.gridStart) renderMonth();
    $("#postAs").textContent = t("posting_as", { name: myName() });
    if (current && $("#detailDialog").open) renderDetail();
    if ($("#eventDialog").open) { renderFormFeed(); fillMemberSelect(); renderLabelPicker(selectedLabel()); $("#eventDialogTitle").textContent = editing ? t("edit_event") : t("new_event"); }
  }
}
async function changeLang(code, saveToAccount) {
  setLang(code);
  rerenderAll();
  if (saveToAccount && token()) {
    try { state.me = { ...state.me, ...(await api("/api/auth/me", { method: "PATCH", body: { lang: code } })) }; } catch {}
  }
}
$("#authLang").addEventListener("change", (ev) => changeLang(ev.target.value, false));
$("#langSelect").addEventListener("change", (ev) => changeLang(ev.target.value, true));

// ---------- 页签 ----------
document.querySelectorAll(".tabbar button").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
function showView(v) {
  state.view = v;
  document.querySelectorAll(".view").forEach((s) => s.classList.toggle("active", s.id === `view-${v}`));
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  const cal = v === "calendar";
  ["#prevMonth", "#nextMonth", "#todayBtn"].forEach((s) => ($(s).style.visibility = cal ? "visible" : "hidden"));
  $("#title").textContent = cal ? monthTitle() : { members: t("tab_members"), week: t("tab_week"), claude: t("tab_claude"), settings: t("tab_settings") }[v];
  if (v === "members") renderMembers();
  if (v === "week") renderWeek();
  if (v === "settings") renderSettings();
}

// ---------- 月历 ----------
const monthTitle = () => state.month.toLocaleDateString(locale(), { year: "numeric", month: "long" });
const eventColor = (e) => e.color || e.member_color || DEFAULT_COLOR;

async function loadMonth() {
  const gridStart = new Date(state.month); gridStart.setDate(1 - state.month.getDay());
  const gridEnd = new Date(gridStart); gridEnd.setDate(gridStart.getDate() + 42);
  state.gridStart = gridStart;
  state.events = await api(`/api/events?from=${gridStart.toISOString()}&to=${gridEnd.toISOString()}`);
  renderMonth();
}
// 一个行程涵盖的每一天（跨天行程每天都显示）
function eventDays(e) {
  const s = new Date(e.start); s.setHours(0, 0, 0, 0);
  const end = new Date(e.end || e.start);
  const days = [];
  for (let d = new Date(s); d <= end && days.length < 62; d.setDate(d.getDate() + 1)) days.push(dayKey(d));
  return days.length ? days : [dayKey(s)];
}
function eventsByDay() {
  const map = {};
  for (const e of state.events) for (const k of eventDays(e)) (map[k] ||= []).push(e);
  return map;
}
function renderMonth() {
  if (state.view === "calendar") $("#title").textContent = monthTitle();
  const byDay = eventsByDay();
  const todayK = dayKey(new Date()), selK = dayKey(state.selected);
  let html = "";
  for (let i = 0; i < 42; i++) {
    const d = new Date(state.gridStart); d.setDate(d.getDate() + i);
    const k = dayKey(d), evs = byDay[k] || [];
    const cls = ["day", d.getMonth() !== state.month.getMonth() && "other", k === todayK && "today",
      k === selK && "selected", d.getDay() === 0 && "sun", d.getDay() === 6 && "sat"].filter(Boolean).join(" ");
    html += `<div class="${cls}" data-day="${k}"><span class="num">${d.getDate()}</span>
      ${evs.slice(0, 3).map((e) => `<div class="chip" style="--c:${esc(eventColor(e))}">${esc(e.title)}</div>`).join("")}
      ${evs.length > 3 ? `<div class="more">+${evs.length - 3}</div>` : ""}</div>`;
  }
  $("#monthGrid").innerHTML = html;
  renderDay();
}
// 快速新增：在选中的那天输入标题就新增（全天）；「更多…」打开完整表单
$("#quickAdd").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const title = $("#quickTitle").value.trim();
  if (!title) { $("#quickTitle").focus(); return; }
  const btn = $("#quickAdd button[type=submit]"); btn.disabled = true;
  try {
    const d = new Date(state.selected); d.setHours(0, 0, 0, 0);
    await api("/api/events", { method: "POST", body: { title, all_day: true, start: d.toISOString(), end: null, remind: true } });
    $("#quickTitle").value = "";
    toast(t("qa_added"));
    await loadMonth();
  } catch (e) { toast(t("save_failed", { error: e.message })); }
  btn.disabled = false;
});
$("#quickMore").onclick = () => {
  const title = $("#quickTitle").value.trim();
  openEditor(null, state.selected);
  if (title) eventForm.title.value = title;
  $("#quickTitle").value = "";
};

$("#monthGrid").addEventListener("click", (ev) => {
  const cell = ev.target.closest(".day");
  if (!cell) return;
  const [y, m, d] = cell.dataset.day.split("-").map(Number);
  const picked = new Date(y, m - 1, d);
  if (dayKey(picked) === dayKey(state.selected)) return openEditor(null, picked); // 再点一次 = 新增
  state.selected = picked;
  if (picked.getMonth() !== state.month.getMonth()) { state.month = new Date(y, m - 1, 1); loadMonth(); } else renderMonth();
});
function renderDay() {
  const k = dayKey(state.selected);
  $("#dayTitle").textContent = state.selected.toLocaleDateString(locale(), { month: "long", day: "numeric", weekday: "long" });
  const evs = eventsByDay()[k] || [];
  $("#dayList").innerHTML = evs.length ? evs.map((e) => `
    <li class="item tinted${e.color ? " lbl" : ""}" data-id="${e.id}" style="--c:${esc(eventColor(e))}">
      <span class="bar" style="background:${esc(eventColor(e))}"></span>
      <div class="main">
        <div class="t">${esc(e.title)}</div>
        <div class="s">${e.all_day ? esc(t("all_day")) : fmtTime(e.start) + (e.end ? " – " + fmtTime(e.end) : "")}${e.member_name ? " · " + esc((e.member_emoji ? e.member_emoji + " " : "") + e.member_name) : ""}${e.photo_count ? " · 📷" + e.photo_count : ""}${e.memo_count ? " · 💬" + e.memo_count : ""}</div>
      </div>
      <button type="button" class="card-del" data-del="${e.id}" title="${esc(t("menu_delete"))}" aria-label="${esc(t("menu_delete"))}">🗑</button>
    </li>`).join("") : `<li class="empty">${esc(t("day_empty"))}</li>`;
}
$("#dayList").addEventListener("click", (ev) => {
  const del = ev.target.closest("[data-del]");
  if (del) { ev.stopPropagation(); const e = state.events.find((x) => x.id === Number(del.dataset.del)); if (e) deleteEventAsk(e); return; }
  const li = ev.target.closest(".item"); if (li) openDetail(Number(li.dataset.id));
});
// 删除行程：App 和 Google 日历都会删除
async function deleteEventAsk(e, after) {
  const msg = t("delete_event_confirm", { title: e.title }) + (state.me?.google ? t("delete_event_confirm_g") : "");
  if (!(await askConfirm(msg, t("delete")))) return false;
  try {
    await api(`/api/events/${e.id}`, { method: "DELETE" });
    toast(t("deleted"));
    after?.();
    await loadMonth();
    if (state.view === "week") renderWeek();
    return true;
  } catch (err) { toast(err.message); return false; }
}
$("#prevMonth").onclick = () => { state.month.setMonth(state.month.getMonth() - 1); loadMonth(); };
$("#nextMonth").onclick = () => { state.month.setMonth(state.month.getMonth() + 1); loadMonth(); };
$("#todayBtn").onclick = () => { const d = new Date(); state.selected = d; state.month = new Date(d.getFullYear(), d.getMonth(), 1); loadMonth(); };
$("#addEventBtn").onclick = () => openEditor(null, state.selected);

// ---------- 行程详情 + 时间线 ----------
let current = null; // 正在看的行程（含 feed）
async function openDetail(id) {
  try { current = await api(`/api/events/${id}`); } catch (e) { toast(e.message); return; }
  renderDetail();
  $("#detailMenu").hidden = true;
  $("#postAs").textContent = t("posting_as", { name: myName() });
  if (!$("#detailDialog").open) $("#detailDialog").showModal();
  history.replaceState(null, "", `#event-${id}`);
  const body = $("#detailBody");
  requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
}
const closeDetail = () => $("#detailDialog").close();
$("#detailDialog").addEventListener("close", () => { current = null; if (location.hash.startsWith("#event-")) history.replaceState(null, "", location.pathname); });
$("#detailClose").onclick = closeDetail;

function renderDetail() {
  const e = current;
  const color = eventColor(e);
  $("#dTitle").textContent = e.title;
  $("#dTitle").style.color = `color-mix(in srgb, ${color} 45%, #1d2740)`; // 粉彩色太浅，标题用深一点
  const s = new Date(e.start), end = e.end ? new Date(e.end) : null;
  const sameDay = !end || dayKey(s) === dayKey(end);
  const setDate = (pre, d) => {
    $(`#${pre}Year`).textContent = d.getFullYear();
    $(`#${pre}Day`).textContent = d.toLocaleDateString(locale(), { month: "short", day: "numeric", weekday: "short" });
    $(`#${pre}Time`).textContent = e.all_day ? "" : fmtTime(d.toISOString());
  };
  setDate("dStart", s);
  if (end && !(e.all_day && sameDay)) { setDate("dEnd", end); $("#dEndBox").hidden = false; $("#dArrow").hidden = false; }
  else { $("#dEndBox").hidden = true; $("#dArrow").hidden = true; if (e.all_day) $("#dStartTime").textContent = t("all_day"); }
  $("#dArrow").style.color = color;
  $("#dMemberRow").hidden = !e.member_name;
  $("#dMember").textContent = e.member_name ? (e.member_emoji ? e.member_emoji + " " : "") + e.member_name : "";
  $("#dRemind").textContent = e.remind ? t("remind_on") : t("remind_off");
  const label = e.label && state.labels[e.label];
  $("#dLabelRow").hidden = !label;
  if (label) $("#dLabel").innerHTML = `<span class="dot" style="background:${esc(label.hex)}"></span>${esc(labelName(e.label))}`;
  $("#dNotesRow").hidden = !e.notes;
  $("#dNotes").textContent = e.notes || "";
  renderCustomer(e);
  // 我自己的 Google 日历同步状态
  const g = $("#dGoogle");
  $("#dGoogleRow").hidden = !state.me?.google;
  g.className = "";
  if (e.google?.error) { g.textContent = t("g_row_error", { error: e.google.error }); g.className = "warn"; }
  else if (e.google?.synced_at) g.textContent = t("g_row_synced", { time: fmtDateTime(e.google.synced_at) });
  else g.textContent = t("g_row_pending");
  renderFeed();
}

// 给客户的 WhatsApp：电话、讯息、发送状态、立即发送 / 取消自动发送
function renderCustomer(e) {
  const has = !!(e.customer_phone || e.customer_note);
  $("#dCustomerRow").hidden = !has;
  if (!has) return;
  $("#dCustomerPhone").textContent = e.customer_phone ? `📞 ${e.customer_phone}` : "";
  $("#dCustomerNote").textContent = e.customer_note || "";
  const st = $("#dCustomerStatus"), phone = e.customer_phone || "";
  const ready = !!state.config?.whatsapp, auto = e.customer_auto !== 0;
  st.className = "hint";
  if (!ready) { st.textContent = t("c_not_ready"); st.classList.add("warn"); }
  else if (e.customer_error) { st.textContent = t("c_failed", { error: e.customer_error }); st.classList.add("warn"); }
  else if (e.customer_sent_at) st.textContent = t("c_sent", { phone, time: fmtDateTime(e.customer_sent_at) });
  else if (!auto) st.textContent = t("c_off");
  else if (e.customer_send_at && new Date(e.start) > new Date()) st.textContent = t("c_will_send", { phone, time: fmtDateTime(e.customer_send_at) });
  else st.textContent = t("c_past");
  const allowed = !!state.me?.can_whatsapp;
  const canSend = allowed && ready && !!e.customer_phone && !!e.customer_note;
  $("#dCustSend").hidden = !canSend;
  $("#dCustToggle").hidden = !allowed || !ready || !!e.customer_sent_at;
  $("#dCustToggle").textContent = auto ? t("c_cancel") : t("c_resume");
}
$("#dCustSend").onclick = async () => {
  if (!current) return;
  if (!(await askConfirm(t("c_confirm_send", { phone: current.customer_phone }), t("c_send_now")))) return;
  const btn = $("#dCustSend"); btn.disabled = true;
  try { current = await api(`/api/events/${current.id}/customer-send`, { method: "POST", body: {} }); renderDetail(); toast(t("c_sent_toast")); }
  catch (err) { toast(err.message); try { current = await api(`/api/events/${current.id}`); renderDetail(); } catch {} }
  btn.disabled = false;
};
$("#dCustToggle").onclick = async () => {
  if (!current) return;
  const btn = $("#dCustToggle"); btn.disabled = true;
  try { await api(`/api/events/${current.id}`, { method: "PATCH", body: { customer_auto: current.customer_auto === 0 } }); current = await api(`/api/events/${current.id}`); renderDetail(); }
  catch (err) { toast(err.message); }
  btn.disabled = false;
};

function logText(f) {
  if (f.body === "created") return t("log_created");
  if (f.body === "customer_sent") return t("log_customer_sent");
  if (f.body === "customer_failed") return t("log_customer_failed");
  if (f.body === "done") return t("log_done");
  if (f.body === "undone") return t("log_undone");
  if (f.body.startsWith("updated:")) {
    const fields = f.body.slice(8).split(",").filter(Boolean).map((k) => t(`field_${k}`));
    return t("log_updated", { fields: fields.join(t("list_sep")) });
  }
  return f.body; // 旧资料
}
function renderFeed() { renderFeedInto($("#feed"), current.feed || []); }
function renderFeedInto(container, feed) {
  const me = myName();
  let html = "", lastDay = "", lastAuthor = null, lastTime = 0;
  for (const f of feed) {
    const tm = new Date(f.created_at);
    const dk = dayKey(tm);
    if (dk !== lastDay) { html += `<div class="sep"><span>${esc(fmtLongDate(tm))}</span></div>`; lastDay = dk; lastAuthor = null; }
    if (f.type === "log") {
      html += `<div class="sys"><span>${f.author ? `<b>${esc(f.author)}</b> ` : ""}${esc(logText(f))} · ${fmtTime(f.created_at)}</span></div>`;
      lastAuthor = null;
      continue;
    }
    // 同一个人、5 分钟内连续发的内容合在一起（只显示一次头像和名字）
    const grouped = f.author === lastAuthor && tm - lastTime < 5 * 60_000;
    const mine = !!me && f.author === me;
    const inner = f.type === "comment"
      ? `<div class="bubble">${esc(f.body)}</div>`
      : `<button type="button" class="photo-post" data-photo="${f.id}"><img src="${photoUrl(f.id)}" alt="${esc(t("photo_of", { name: author(f.author) }))}" loading="lazy" />${f.comment_count ? `<span class="cc">💬 ${f.comment_count}</span>` : ""}</button>${f.caption ? `<div class="bubble">${esc(f.caption)}</div>` : ""}`;
    html += `<div class="post ${mine ? "mine" : ""} ${grouped ? "grouped" : ""}">
      ${grouped ? `<span class="avatar ghost"></span>` : avatar(f.author)}
      <div class="post-main">
        ${grouped ? "" : `<div class="post-who"><b>${esc(author(f.author))}</b></div>`}
        <div class="post-content">${inner}
          <span class="post-time">${fmtTime(f.created_at)}${f.type === "comment" ? ` <button type="button" class="del" data-comment-del="${f.id}">${esc(t("delete"))}</button>` : ""}</span>
        </div>
      </div>
    </div>`;
    lastAuthor = f.author; lastTime = +tm;
  }
  if (!feed.some((f) => f.type !== "log")) html += `<p class="feed-empty">${esc(t("feed_empty"))}</p>`;
  container.innerHTML = html;
}
async function onFeedClick(ev) {
  const ph = ev.target.closest("[data-photo]");
  if (ph) return openPhoto(Number(ph.dataset.photo));
  const del = ev.target.dataset.commentDel;
  if (del && (await askConfirm(t("delete_comment_confirm"), t("delete")))) {
    await api(`/api/comments/${del}`, { method: "DELETE" });
    current = await api(`/api/events/${current.id}`);
    if ($("#detailDialog").open) renderDetail();
    if ($("#eventDialog").open) renderFormFeed();
    loadMonth();
  }
}
$("#feed").addEventListener("click", onFeedClick);
$("#formFeed").addEventListener("click", onFeedClick);

// 菜单
$("#detailMenuBtn").onclick = (ev) => { ev.stopPropagation(); $("#detailMenu").hidden = !$("#detailMenu").hidden; };
$("#detailDialog").addEventListener("click", (ev) => { if (!ev.target.closest(".menu-wrap")) $("#detailMenu").hidden = true; });
$("#detailEditBtn").onclick = () => { $("#detailMenu").hidden = true; openEditor(current); };
$("#detailSyncBtn").onclick = async () => {
  $("#detailMenu").hidden = true;
  if (!state.me?.google) { toast(t("sync_need_connect")); return; }
  try {
    const r = await api(`/api/events/${current.id}/sync`, { method: "POST", body: {} });
    toast(r.ok ? t("sync_ok") : t("sync_fail", { error: r.error || "" }));
  } catch (e) { toast(t("sync_fail", { error: e.message })); }
  openDetail(current.id);
};
$("#detailDeleteBtn").onclick = () => { $("#detailMenu").hidden = true; deleteEventAsk(current, closeDetail); };
$("#detailTrashBtn").onclick = () => deleteEventAsk(current, closeDetail);

// 发留言 / 照片
let postFiles = [];
const thumbs = (files) => files.map((f, i) => `<span class="pv-thumb"><img src="${URL.createObjectURL(f)}" alt="" /><button type="button" data-rm="${i}" aria-label="${esc(t("remove"))}">×</button></span>`).join("");
$("#postPhotos").addEventListener("change", (ev) => {
  postFiles = [...postFiles, ...ev.target.files].slice(0, 10);
  ev.target.value = "";
  $("#postPreview").innerHTML = thumbs(postFiles);
});
$("#postPreview").addEventListener("click", (ev) => {
  const i = ev.target.dataset.rm;
  if (i !== undefined) { postFiles.splice(Number(i), 1); $("#postPreview").innerHTML = thumbs(postFiles); }
});
async function postToEvent(eventId, text, files) {
  const fd = new FormData();
  fd.append("text", text);
  for (const f of files) fd.append("photos", await shrinkForUpload(f));
  return api(`/api/events/${eventId}/posts`, { method: "POST", body: fd });
}
$("#postForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const text = $("#postInput").value.trim();
  if (!text && !postFiles.length) return;
  const btn = $("#postSend");
  btn.disabled = true; btn.textContent = postFiles.length ? t("uploading") : t("sending");
  try {
    current = await postToEvent(current.id, text, postFiles);
    $("#postInput").value = ""; postFiles = []; $("#postPreview").innerHTML = "";
    renderDetail();
    $("#detailBody").scrollTop = $("#detailBody").scrollHeight;
    loadMonth();
  } catch (e) { toast(t("send_failed", { error: e.message })); }
  btn.disabled = false; btn.textContent = t("send");
});
enterToSend($("#postInput"), () => $("#postForm").requestSubmit());

// ---------- 照片查看 + 评论 ----------
let viewerIndex = 0;
const feedPhotos = () => (current?.feed || []).filter((f) => f.type === "photo");
async function openPhoto(photoId) {
  const photos = feedPhotos();
  viewerIndex = Math.max(0, photos.findIndex((p) => p.id === photoId));
  await showPhoto();
  if (!$("#photoViewer").open) $("#photoViewer").showModal();
}
async function showPhoto() {
  const photos = feedPhotos(), p = photos[viewerIndex];
  if (!p) return;
  $("#photoViewerImg").src = photoUrl(p.id);
  $("#photoViewerImg").alt = t("photo_of", { name: author(p.author) });
  $("#pvCounter").textContent = `${viewerIndex + 1} / ${photos.length}`;
  $("#pvBy").innerHTML = `${avatar(p.author)} <b>${esc(author(p.author))}</b> · ${esc(fmtDateTime(p.created_at))}`;
  $("#pvCaption").textContent = p.caption || "";
  $("#pvPrev").hidden = viewerIndex === 0;
  $("#pvNext").hidden = viewerIndex === photos.length - 1;
  $("#pvInput").value = "";
  renderPhotoComments(await api(`/api/photos/${p.id}/comments`));
}
function renderPhotoComments(list) {
  $("#pvComments").innerHTML = list.length ? list.map((c) => `
    <li class="comment">${avatar(c.author)}
      <div class="cbubble"><div class="meta"><b>${esc(author(c.author))}</b><span>${fmtDateTime(c.created_at)}</span>
        <button type="button" class="del" data-comment-del="${c.id}">${esc(t("delete"))}</button></div>
        <div class="text">${esc(c.body)}</div></div>
    </li>`).join("") : `<li class="none">${esc(t("no_comments"))}</li>`;
}
$("#pvPrev").onclick = () => { viewerIndex--; showPhoto(); };
$("#pvNext").onclick = () => { viewerIndex++; showPhoto(); };
$("#pvClose").onclick = () => $("#photoViewer").close();
$("#photoViewer").addEventListener("click", (ev) => { if (ev.target === $("#photoViewer")) $("#photoViewer").close(); });
$("#photoViewer").addEventListener("close", async () => {
  if (!current) return;
  current = await api(`/api/events/${current.id}`);
  if ($("#detailDialog").open) renderDetail();
  if ($("#eventDialog").open) renderFormFeed();
});
async function sendPhotoComment() {
  const body = $("#pvInput").value.trim();
  if (!body) return;
  const p = feedPhotos()[viewerIndex];
  try {
    await api(`/api/photos/${p.id}/comments`, { method: "POST", body: { body } });
    $("#pvInput").value = "";
    renderPhotoComments(await api(`/api/photos/${p.id}/comments`));
  } catch (e) { toast(t("send_failed", { error: e.message })); }
}
$("#pvSendBtn").onclick = sendPhotoComment;
enterToSend($("#pvInput"), sendPhotoComment);
$("#pvComments").addEventListener("click", async (ev) => {
  const id = ev.target.dataset.commentDel;
  if (!id || !(await askConfirm(t("delete_comment_confirm"), t("delete")))) return;
  await api(`/api/comments/${id}`, { method: "DELETE" });
  showPhoto();
});
$("#pvDelete").onclick = async () => {
  const p = feedPhotos()[viewerIndex];
  if (!(await askConfirm(t("delete_photo_confirm"), t("delete")))) return;
  await api(`/api/photos/${p.id}`, { method: "DELETE" });
  $("#photoViewer").close();
  loadMonth();
};

// ---------- 新增 / 编辑行程 ----------
let editing = null;
const eventForm = $("#eventForm");
const NEW_MEMBER = "__new";
function fillMemberSelect() {
  const keep = eventForm.member_id.value;
  eventForm.member_id.innerHTML = `<option value="">${esc(t("member_none"))}</option>`
    + state.members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join("")
    + `<option value="${NEW_MEMBER}">${esc(t("member_new_opt"))}</option>`;
  if (keep) eventForm.member_id.value = keep;
}
function renderLabelPicker(selected) {
  const opts = [["", t("label_none"), "transparent"], ...orderedLabels().map(([id, l]) => [id, labelName(id), l.hex])];
  $("#labelPicker").setAttribute("aria-label", t("f_label"));
  $("#labelPicker").innerHTML = opts.map(([id, name, hex]) => `
    <button type="button" role="radio" aria-checked="${String(id) === String(selected ?? "")}" data-label="${id}" title="${esc(name)}" aria-label="${esc(name)}"
      class="swatch ${id ? "" : "none"}" style="--c:${hex}">${id ? "" : esc(name)}</button>`).join("");
}
$("#labelPicker").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-label]");
  if (b) $("#labelPicker").querySelectorAll("[data-label]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
});
const selectedLabel = () => $("#labelPicker [aria-checked=true]")?.dataset.label || null;

function setAllDay(on) {
  for (const name of ["start", "end"]) {
    const input = eventForm[name], v = input.value;
    input.type = on ? "date" : "datetime-local";
    if (v) input.value = on ? v.slice(0, 10) : (v.length === 10 ? `${v}T${name === "start" ? "10:00" : "11:00"}` : v);
  }
}
$("#allDayCheck").addEventListener("change", (ev) => setAllDay(ev.target.checked));

// 编辑表单里的「留言 / 照片」：已有行程 → 马上发出；新行程 → 按「保存」时一起发出
let formFiles = [];
function renderFormFeed() {
  const feed = editing && current && current.id === editing.id ? current.feed || [] : [];
  $("#formFeed").hidden = !editing;
  if (editing) renderFeedInto($("#formFeed"), feed);
  $("#formChatSend").hidden = !editing;
  $("#formChatHint").textContent = editing ? t("posting_as", { name: myName() }) : t("f_chat_hint_new");
}
$("#formPhotos").addEventListener("change", (ev) => { formFiles = [...formFiles, ...ev.target.files].slice(0, 10); ev.target.value = ""; $("#formPreview").innerHTML = thumbs(formFiles); });
$("#formPreview").addEventListener("click", (ev) => { const i = ev.target.dataset.rm; if (i !== undefined) { formFiles.splice(Number(i), 1); $("#formPreview").innerHTML = thumbs(formFiles); } });
async function sendFormChat() {
  if (!editing) return;
  const text = $("#formChatInput").value.trim();
  if (!text && !formFiles.length) return;
  const btn = $("#formChatSend");
  btn.disabled = true; btn.textContent = formFiles.length ? t("uploading") : t("sending");
  try {
    current = await postToEvent(editing.id, text, formFiles);
    $("#formChatInput").value = ""; formFiles = []; $("#formPreview").innerHTML = "";
    renderFormFeed();
    $("#formFeed").lastElementChild?.scrollIntoView({ block: "nearest" });
    loadMonth();
  } catch (e) { toast(t("send_failed", { error: e.message })); }
  btn.disabled = false; btn.textContent = t("send");
}
$("#formChatSend").onclick = sendFormChat;
$("#formChatInput").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); if (editing) sendFormChat(); }
});

function openEditor(e, day) {
  editing = e || null;
  formFiles = []; $("#formPreview").innerHTML = "";
  eventForm.reset();
  fillMemberSelect();
  $("#newMemberRow").hidden = true;
  $("#fCustomerNotReady").hidden = !!state.config?.whatsapp;
  $(".customer-box").hidden = !state.me?.can_whatsapp; // 只有管理员允许的帐号可以设定
  if (state.me?.can_whatsapp) loadWaUsage();
  $("#eventDialogTitle").textContent = e ? t("edit_event") : t("new_event");
  eventForm.all_day.checked = !!e?.all_day;
  eventForm.start.type = eventForm.end.type = e?.all_day ? "date" : "datetime-local";
  if (e) {
    eventForm.title.value = e.title;
    eventForm.start.value = e.all_day ? toLocalInput(e.start).slice(0, 10) : toLocalInput(e.start);
    eventForm.end.value = e.end ? (e.all_day ? toLocalInput(e.end).slice(0, 10) : toLocalInput(e.end)) : "";
    eventForm.member_id.value = e.member_id ?? "";
    eventForm.remind.checked = !!e.remind;
    eventForm.notes.value = e.notes ?? "";
    eventForm.customer_phone.value = e.customer_phone ?? "";
    eventForm.customer_note.value = e.customer_note ?? "";
    eventForm.customer_auto.checked = e.customer_auto !== 0;
  } else {
    const d = new Date(day || new Date()); d.setHours(10, 0, 0, 0);
    eventForm.start.value = toLocalInput(d.toISOString());
    eventForm.remind.checked = true;
    eventForm.customer_auto.checked = true;
  }
  renderLabelPicker(e?.label);
  $("#formChatInput").value = "";
  renderFormFeed();
  $("#eventDialog").showModal();
}
eventForm.member_id.addEventListener("change", () => {
  const isNew = eventForm.member_id.value === NEW_MEMBER;
  $("#newMemberRow").hidden = !isNew;
  if (isNew) { $("#newMemberName").value = ""; $("#newMemberName").focus(); }
});
$("#newMemberCancel").onclick = () => { $("#newMemberRow").hidden = true; eventForm.member_id.value = ""; };
$("#newMemberAdd").onclick = async () => {
  const name = $("#newMemberName").value.trim();
  if (!name) { toast(t("enter_name")); return; }
  try {
    const m = await api("/api/members", { method: "POST", body: { name } });
    state.members = await api("/api/members");
    eventForm.member_id.value = "";
    fillMemberSelect();
    eventForm.member_id.value = String(m.id);
    $("#newMemberRow").hidden = true;
    toast(t("member_added", { name: m.name }));
  } catch (e) { toast(t("add_failed", { error: e.message })); }
};
$("#newMemberName").addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); $("#newMemberAdd").click(); } });

eventForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = eventForm;
  if (f.member_id.value === NEW_MEMBER) { toast(t("pick_member_first")); return; }
  const allDay = f.all_day.checked;
  const toIso = (v, endOfDay) => (!v ? null : allDay ? new Date(`${v}T${endOfDay ? "23:59" : "00:00"}`).toISOString() : fromLocalInput(v));
  const body = {
    title: f.title.value.trim(), all_day: allDay,
    start: toIso(f.start.value, false), end: toIso(f.end.value, true),
    member_id: f.member_id.value ? Number(f.member_id.value) : null,
    label: selectedLabel(), remind: f.remind.checked, notes: f.notes.value.trim() || null,
    customer_phone: f.customer_phone.value.trim() || null, customer_note: f.customer_note.value.trim() || null,
    customer_auto: f.customer_auto.checked,
  };
  try {
    const saved = editing
      ? await api(`/api/events/${editing.id}`, { method: "PATCH", body })
      : await api("/api/events", { method: "POST", body });
    // 表单里写好、还没发出的留言和照片，一起发出
    const pendingText = $("#formChatInput").value.trim();
    if (pendingText || formFiles.length) {
      await postToEvent(saved.id, pendingText, formFiles);
      $("#formChatInput").value = ""; formFiles = []; $("#formPreview").innerHTML = "";
    }
    $("#eventDialog").close();
    state.selected = new Date(body.start);
    state.month = new Date(state.selected.getFullYear(), state.selected.getMonth(), 1);
    await loadMonth();
    toast(t("saved"));
    openDetail(saved.id);
  } catch (e) { toast(t("save_failed", { error: e.message })); }
});
$("#cancelEventBtn").onclick = () => $("#eventDialog").close();

// ---------- 成员 ----------
let editingMember = null;
const memberForm = $("#memberForm");
// 颜色标签：每个颜色可以取名字（所有人共用）
function renderLabels() {
  $("#labelList").innerHTML = orderedLabels().map(([id, l]) => `
    <li><span class="label-swatch" style="background:${esc(l.hex)}"></span>
      <span class="label-base">${esc(t(`label_${id}`))}</span>
      <input data-label-id="${id}" value="${esc(state.labelNames[id] || "")}" placeholder="${esc(t(`label_ex_${id}`))}" maxlength="30" /></li>`).join("");
}
$("#labelList").addEventListener("change", async (ev) => {
  const inp = ev.target.closest("[data-label-id]");
  if (!inp) return;
  try {
    const r = await api(`/api/labels/${inp.dataset.labelId}`, { method: "PUT", body: { name: inp.value } });
    state.labelNames = r.labelNames || {};
    toast(t("label_saved"));
    renderMonth();
  } catch (e) { toast(t("save_failed", { error: e.message })); }
});

// 可爱 / 搞笑的头像
const EMOJIS = ["🐱", "🐶", "🐼", "🐨", "🐰", "🦊", "🐻", "🐷", "🐸", "🐵", "🙈", "🐥", "🐧", "🦄", "🦖", "🐙", "🐳", "🦋", "🐝", "🐞",
  "🌸", "🌈", "⭐", "🍓", "🍑", "🍩", "🧁", "🍦", "🎀", "🎈", "👻", "🤡", "💩", "🤪", "😜", "😎", "🥳", "🤠", "🤓", "😴", "🤖", "👽", "👑", "💖"];
function renderEmojiPicker(selected) {
  memberForm.emoji.value = selected || "";
  $("#emojiCustom").value = selected && !EMOJIS.includes(selected) ? selected : "";
  $("#emojiPicker").innerHTML = EMOJIS.map((e) => [e, e]).map(([v, txt]) =>
    `<button type="button" role="radio" data-emoji="${esc(v)}" aria-checked="${String((selected || "") === v)}" class="${v ? "" : "none"}">${esc(txt)}</button>`).join("");
}
$("#emojiPicker").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-emoji]");
  if (!b) return;
  memberForm.emoji.value = b.dataset.emoji;
  $("#emojiCustom").value = "";
  $("#emojiPicker").querySelectorAll("[data-emoji]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
});
$("#emojiCustom").addEventListener("input", () => {
  const v = $("#emojiCustom").value.trim();
  memberForm.emoji.value = v;
  $("#emojiPicker").querySelectorAll("[data-emoji]").forEach((x) => x.setAttribute("aria-checked", String(x.dataset.emoji === v)));
});

async function renderMembers() {
  renderLabels();
  state.members = await api("/api/members");
  $("#memberList").innerHTML = state.members.length ? state.members.map((m) => `
    <li class="item" data-id="${m.id}">${avatar(m.name)}<div class="main"><div class="t">${esc(m.name)}</div></div></li>`).join("")
    : `<li class="empty">${esc(t("members_empty"))}</li>`;
}
$("#memberList").addEventListener("click", (ev) => {
  const li = ev.target.closest(".item");
  if (li) openMember(state.members.find((m) => m.id === Number(li.dataset.id)));
});
$("#addMemberBtn").onclick = () => openMember(null);
function openMember(m) {
  editingMember = m;
  memberForm.reset();
  $("#memberDialogTitle").textContent = m ? t("edit_member") : t("new_member");
  memberForm.name.value = m?.name ?? "";
  memberForm.color.value = m?.color || ["#e8a33d", "#e07a5f", "#3d85c6", "#b565a7", "#e0a100", "#2a9d8f", "#d1495b", "#6c757d"][state.members.length % 8];
  // 新的人：先帮他选一个还没人用的 emoji（可以改）
  const used = new Set(state.members.map((x) => x.emoji));
  const free = EMOJIS.filter((e) => !used.has(e));
  renderEmojiPicker(m?.emoji || (free.length ? free : EMOJIS)[Math.floor(Math.random() * (free.length || EMOJIS.length))]);
  $("#deleteMemberBtn").hidden = !m;
  $("#memberDialog").showModal();
}
memberForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const body = { name: memberForm.name.value.trim(), color: memberForm.color.value, emoji: memberForm.emoji.value || null };
  try {
    if (editingMember) await api(`/api/members/${editingMember.id}`, { method: "PATCH", body });
    else await api("/api/members", { method: "POST", body });
    $("#memberDialog").close();
    await renderMembers();
    loadMonth();
  } catch (e) { toast(t("save_failed", { error: e.message })); }
});
$("#cancelMemberBtn").onclick = () => $("#memberDialog").close();
$("#deleteMemberBtn").onclick = async () => {
  if (!(await askConfirm(t("delete_member_confirm", { name: editingMember.name }), t("delete")))) return;
  await api(`/api/members/${editingMember.id}`, { method: "DELETE" });
  $("#memberDialog").close();
  await renderMembers();
  loadMonth();
};

// ---------- 设置 ----------
async function renderSettings() {
  try {
    const [me, set] = await Promise.all([api("/api/auth/me"), api("/api/settings")]);
    state.me = me;
    $("#acctEmail").textContent = me.email;
    $("#waStatus").textContent = state.config?.whatsapp ? t("wa_ready") : t("wa_not_ready");
    $("#waNoAccess").hidden = !!me.can_whatsapp;
    $("#waAdmin").hidden = !me.admin;
    if (me.admin) { loadWaUsers(); loadDigest(); }
    loadWaUsage();
    if (document.activeElement !== $("#acctName")) $("#acctName").value = me.name;
    if (document.activeElement !== $("#tzInput")) $("#tzInput").value = set.timezone;
    $("#icsUrl").value = set.icsUrl;
    $("#gRedirectUri").textContent = state.config.googleRedirectUri || `${location.origin}/api/google/callback`;
    const ready = !!state.config.googleLoginReady;
    $("#gConnected").hidden = !me.google;
    $("#calList").hidden = !me.google;
    if (me.google) loadCalList();
    $("#gConnectForm").hidden = !!me.google;          // 没连接时一定显示：填 Gmail → 连接
    $("#gSetup").hidden = !!me.google || ready;
    $("#gExplain").hidden = !!me.google;               // 已连接就不显示长说明        // 管理员还没设定时，下面显示设定步骤
    if (!$("#gGmail").value) $("#gGmail").value = me.email;
    const st = $("#gStatus");
    st.classList.remove("ok", "warn");
    if (me.google) { st.textContent = t("g_status_connected", { gmail: me.google.gmail, cal: me.google.calendarName || "Google" }); st.classList.add("ok"); }
    else st.textContent = ready ? t("g_status_ready") : t("g_status_notready");
  } catch (e) { if (token()) toast(t("load_failed", { error: e.message })); }
}
$("#gConnectForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const gmail = $("#gGmail").value.trim();
  if (!EMAIL_RE.test(gmail)) { toast(t("err_email")); return; }
  if (!state.config.googleLoginReady) { toast(t("g_not_ready_click")); $("#gSetup").open = true; $("#gSetup").scrollIntoView({ block: "center" }); return; }
  try { const r = await api("/api/google/connect", { method: "POST", body: { gmail } }); location.href = r.url; }
  catch (e) { toast(e.message); }
});
// ---------- 选择要双向同步的 Google 日历 ----------
// WhatsApp 这个月用了几则（让大家知道免费方案还剩多少）
async function loadWaUsage() {
  if (!state.config?.whatsapp) { $("#waUsage").textContent = ""; $("#fWaUsage").textContent = ""; return; }
  try {
    const u = await api("/api/whatsapp/usage");
    const text = u.full ? t("wa_usage_full", { limit: u.limit })
      : u.limit ? t("wa_usage", { sent: u.sent, limit: u.limit, left: u.limit - u.sent })
      : t("wa_usage_nolimit", { sent: u.sent });
    for (const el of [$("#waUsage"), $("#fWaUsage")]) { el.textContent = text; el.classList.toggle("warn", !!u.full); }
    if (document.activeElement !== $("#waLimit")) $("#waLimit").value = u.limit ?? "";
  } catch {}
}
$("#waLimitSave").onclick = async () => {
  const btn = $("#waLimitSave"); btn.disabled = true;
  try { await api("/api/admin/wa-limit", { method: "PUT", body: { limit: Number($("#waLimit").value) || 0 } }); toast(t("saved")); await loadWaUsage(); }
  catch (e) { toast(e.message); }
  btn.disabled = false;
};

// 管理员：勾选哪些帐号可以发 WhatsApp 给客户
async function loadWaUsers() {
  const ul = $("#waUsers");
  try {
    const users = await api("/api/admin/users");
    ul.innerHTML = users.map((u) => `<li><label class="check"><input type="checkbox" data-wa-user="${u.id}" ${u.can_whatsapp ? "checked" : ""} ${u.admin ? "disabled" : ""} />
      <span><b>${esc(u.name)}</b> <span class="muted">${esc(u.email)}${u.admin ? " · " + esc(t("wa_admin_label")) : ""}</span></span></label></li>`).join("");
  } catch (e) { ul.innerHTML = `<li class="warn">${esc(e.message)}</li>`; }
}
$("#waUsers").addEventListener("change", async (ev) => {
  const box = ev.target.closest("[data-wa-user]");
  if (!box) return;
  box.disabled = true;
  try { await api(`/api/admin/users/${box.dataset.waUser}`, { method: "PATCH", body: { can_whatsapp: box.checked } }); toast(t("saved")); }
  catch (e) { box.checked = !box.checked; toast(e.message); }
  box.disabled = false;
});

// 外观：浅色 / 深色 / 跟随手机（只存在这台装置）
(() => {
  const sel = $("#themeSelect");
  let cur = "light";
  try { cur = localStorage.getItem("theme") || "light"; } catch {}
  sel.value = cur;
  sel.addEventListener("change", () => {
    try { localStorage.setItem("theme", sel.value); } catch {}
    if (sel.value === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", sel.value);
  });
})();

// ---------- 这星期：摘要 + 任务清单 ----------
state.weekOffset = 0;      // 0 = 这星期，1 = 下星期，-1 = 上星期
state.weekFilter = null;   // { kind: "member" | "label", id }
function weekStart(offset) { // 星期一开始
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7);
  return d;
}
async function renderWeek() {
  const start = weekStart(state.weekOffset), end = new Date(start); end.setDate(end.getDate() + 7);
  const fmt = (d) => d.toLocaleDateString(locale(), { day: "numeric", month: "short" });
  const last = new Date(end); last.setDate(last.getDate() - 1);
  const name = state.weekOffset === 0 ? t("wk_this") : state.weekOffset === 1 ? t("wk_next") : state.weekOffset === -1 ? t("wk_last") : "";
  $("#weekRange").innerHTML = `${name ? `<b>${esc(name)}</b>` : ""}<span>${esc(fmt(start))} – ${esc(fmt(last))}</span>`;
  let evs = [];
  try { evs = await api(`/api/events?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`); }
  catch (e) { $("#weekDays").innerHTML = `<p class="hint warn">${esc(e.message)}</p>`; return; }
  state.weekEvents = evs;
  // 摘要：总数、完成几个、每个标签几个
  const done = evs.filter((e) => e.done_at).length;
  const byLabel = {};
  for (const e of evs) if (e.label) byLabel[e.label] = (byLabel[e.label] || 0) + 1;
  const pct = evs.length ? Math.round((done / evs.length) * 100) : 0;
  $("#weekSummary").innerHTML = evs.length ? `
    <div class="wk-stats"><b>${esc(t("wk_events", { n: evs.length }))}</b><span>${esc(t("wk_done", { done, n: evs.length }))}</span></div>
    <div class="wk-progress"><span style="width:${pct}%"></span></div>
    <div class="wk-labels">${orderedLabels().filter(([id]) => byLabel[id]).map(([id, l]) =>
      `<span class="chip" style="--c:${esc(l.hex)}">${esc(labelName(id))} · ${byLabel[id]}</span>`).join("")}</div>`
    : `<p class="hint">${esc(t("wk_nothing"))}</p>`;
  // 筛选：全部 / 某个人 / 某个标签
  const people = [...new Map(evs.filter((e) => e.member_id).map((e) => [e.member_id, e])).values()];
  const f = state.weekFilter;
  const chip = (kind, id, html) => `<button type="button" class="wk-filter" data-kind="${kind}" data-id="${esc(id)}" aria-pressed="${String(kind === "all" ? !f : f?.kind === kind && String(f.id) === String(id))}">${html}</button>`;
  $("#weekFilters").innerHTML = evs.length ? chip("all", "", esc(t("wk_all")))
    + people.map((e) => chip("member", e.member_id, esc(`${e.member_emoji || ""} ${e.member_name}`.trim()))).join("")
    + orderedLabels().filter(([id]) => byLabel[id]).map(([id, l]) => chip("label", id, `<span class="dot" style="background:${esc(l.hex)}"></span>${esc(labelName(id))}`)).join("") : "";
  const shown = evs.filter((e) => !f || (f.kind === "member" ? String(e.member_id) === String(f.id) : String(e.label) === String(f.id)));
  // 每一天
  const todayK = dayKey(new Date());
  let html = "";
  for (let i = 0; i < 7; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    const k = dayKey(d), list = shown.filter((e) => dayKey(new Date(e.start)) === k);
    html += `<section class="wk-day${k === todayK ? " today" : ""}${d.getDay() === 0 ? " sun" : d.getDay() === 6 ? " sat" : ""}">
      <h4>${esc(d.toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "short" }))}</h4>
      ${list.length ? `<ul>${list.map((e) => `
        <li class="wk-item tinted${e.color ? " lbl" : ""}${e.done_at ? " done" : ""}" data-id="${e.id}" style="--c:${esc(eventColor(e))}">
          <label class="wk-check"><input type="checkbox" data-done="${e.id}" ${e.done_at ? "checked" : ""} /><span></span></label>
          <span class="bar" style="background:${esc(eventColor(e))}"></span>
          <div class="wk-main"><div class="t">${esc(e.title)}</div>
            <div class="s">${e.all_day ? esc(t("all_day")) : fmtTime(e.start) + (e.end ? " – " + fmtTime(e.end) : "")}${e.member_name ? " · " + esc((e.member_emoji ? e.member_emoji + " " : "") + e.member_name) : ""}${e.label ? " · " + esc(labelName(e.label)) : ""}</div></div>
        </li>`).join("")}</ul>` : `<p class="wk-empty">${esc(t("wk_empty_day"))}</p>`}
    </section>`;
  }
  $("#weekDays").innerHTML = html;
}
$("#weekPrev").onclick = () => { state.weekOffset--; renderWeek(); };
$("#weekNext").onclick = () => { state.weekOffset++; renderWeek(); };
$("#weekFilters").addEventListener("click", (ev) => {
  const b = ev.target.closest(".wk-filter");
  if (!b) return;
  state.weekFilter = b.dataset.kind === "all" ? null : { kind: b.dataset.kind, id: b.dataset.id };
  renderWeek();
});
$("#weekDays").addEventListener("click", async (ev) => {
  const box = ev.target.closest("[data-done]");
  if (box) {
    ev.stopPropagation();
    box.disabled = true;
    try {
      await api(`/api/events/${box.dataset.done}/done`, { method: "POST", body: { done: box.checked } });
      toast(t(box.checked ? "wk_done_toast" : "wk_undone_toast"));
      await renderWeek();
    } catch (e) { box.checked = !box.checked; toast(e.message); }
    box.disabled = false;
    return;
  }
  if (ev.target.closest(".wk-check")) return;
  const li = ev.target.closest(".wk-item");
  if (li) openDetail(Number(li.dataset.id));
});

// ---------- WhatsApp 行程摘要（管理员） ----------
$("#dgHour").innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${String(h).padStart(2, "0")}:00</option>`).join("");
async function loadDigest() {
  try {
    const d = await api("/api/digest");
    $("#dgMode").value = d.mode || "off";
    $("#dgHour").value = String(d.hour ?? 8);
    $("#dgPhones").value = (d.phones || []).join(", ");
    $("#dgPreview").textContent = (d.preview || "").split(" | ").join("\n");
  } catch (e) { $("#dgPreview").textContent = e.message; }
}
$("#dgSave").onclick = async () => {
  const btn = $("#dgSave"); btn.disabled = true;
  try {
    const d = await api("/api/digest", { method: "PUT", body: { mode: $("#dgMode").value, hour: $("#dgHour").value, phones: $("#dgPhones").value } });
    $("#dgPreview").textContent = (d.preview || "").split(" | ").join("\n");
    toast(t("saved"));
  } catch (e) { toast(t("save_failed", { error: e.message })); }
  btn.disabled = false;
};

// 「我的日历」清单：勾选要同步哪些日历（主日历一定同步）
async function loadCalList() {
  const ul = $("#syncCals");
  try {
    const cals = await api("/api/google/calendars");
    ul.innerHTML = cals.length ? cals.map((c) => `<li><label class="check"><input type="checkbox" data-cal="${esc(c.id)}" data-name="${esc(c.name)}" ${c.enabled ? "checked" : ""} ${c.primary ? "disabled" : ""} />
      <span><b>${esc(c.name)}</b>${c.primary ? ` <span class="muted">${esc(t("cals_main"))}</span>` : ""}</span></label></li>`).join("")
      : `<li class="muted">${esc(t("cals_none"))}</li>`;
  } catch (e) { ul.innerHTML = `<li class="warn">${esc(e.message)}</li>`; }
}
$("#syncCals").addEventListener("change", async (ev) => {
  const box = ev.target.closest("[data-cal]");
  if (!box) return;
  const name = box.dataset.name, enabled = box.checked;
  if (!enabled && !(await askConfirm(t("cals_off_confirm", { name }), t("ok")))) { box.checked = true; return; }
  box.disabled = true;
  try {
    await api(`/api/google/calendars/${encodeURIComponent(box.dataset.cal)}`, { method: "PUT", body: { enabled } });
    toast(t(enabled ? "cals_on_done" : "cals_off_done", { name }));
    if (enabled) pullGoogle(); else loadMonth();
  } catch (e) { box.checked = !enabled; toast(e.message); }
  box.disabled = false;
});

async function loadSyncCalendars() {
  const sel = $("#syncCalendar");
  sel.innerHTML = `<option value="">${esc(t("cal_loading"))}</option>`;
  try {
    const cals = await api("/api/google/calendars");
    sel.innerHTML = cals.map((c) => `<option value="${esc(c.id)}" ${c.current ? "selected" : ""}>${esc(c.name)}${c.current ? esc(t("cal_current")) : ""}</option>`).join("");
  } catch (e) { sel.innerHTML = `<option value="">${esc(e.message)}</option>`; }
}
async function syncAllLoop() {
  for (let i = 0; i < 30; i++) {
    const r = await api("/api/google/sync-all", { method: "POST", body: {} });
    if (r.done) return r;
  }
}
$("#syncCalBtn").onclick = async () => {
  const sel = $("#syncCalendar"), calendarId = sel.value, out = $("#syncCalResult"), btn = $("#syncCalBtn");
  if (!calendarId) return;
  const name = sel.options[sel.selectedIndex].textContent.replace(t("cal_current"), "");
  if (!(await askConfirm(t("cal_confirm", { name }), t("cal_btn")))) return;
  btn.disabled = true; out.classList.remove("warn");
  try {
    await api("/api/google/sync-calendar", { method: "POST", body: { calendarId } });
    // 1) 把那个日历的行程读进 App（大日历会分好几次）
    let created = 0;
    for (let i = 0; i < 200; i++) {
      out.textContent = t("cal_pulling", { name, created });
      const r = await api("/api/google/pull", { method: "POST", body: { force: true } });
      if (r.error) throw new Error(r.error);
      if (r.skipped) { await new Promise((ok) => setTimeout(ok, 1500)); continue; } // 另一个读取正在跑，等一下
      created += r.created || 0;
      if (r.done) break;
    }
    await loadMonth();
    // 2) 把 App 原有的行程写进那个日历
    out.textContent = t("cal_pushing", { name });
    await syncAllLoop();
    out.textContent = t("cal_done", { name, created });
    renderSettings();
  } catch (e) { out.textContent = t("cal_fail", { error: e.message }); out.classList.add("warn"); }
  btn.disabled = false;
};

$("#gSyncAllBtn").onclick = async () => {
  const btn = $("#gSyncAllBtn"), out = $("#gSyncResult");
  btn.disabled = true; out.textContent = t("g_syncing"); out.classList.remove("warn");
  try {
    const r = await api("/api/google/sync-all", { method: "POST", body: {} });
    out.textContent = t("g_sync_result", { ok: r.ok, total: r.total }) + (r.failed ? t("g_sync_failed_part", { failed: r.failed, error: r.lastError }) : "") + (r.done ? "" : t("g_sync_more"));
    if (r.failed) out.classList.add("warn");
  } catch (e) { out.textContent = t("g_sync_fail", { error: e.message }); out.classList.add("warn"); }
  btn.disabled = false;
};
$("#gDisconnectBtn").onclick = async () => {
  if (!(await askConfirm(t("g_disconnect_confirm"), t("g_disconnect")))) return;
  await api("/api/google/disconnect", { method: "POST", body: {} });
  toast(t("g_disconnected"));
  renderSettings();
};
$("#acctNameSave").onclick = async () => {
  try {
    const me = await api("/api/auth/me", { method: "PATCH", body: { name: $("#acctName").value } });
    state.me = { ...state.me, name: me.name };
    state.members = await api("/api/members");
    $("#postAs").textContent = t("posting_as", { name: me.name });
    toast(t("renamed", { name: me.name }));
  } catch (e) { toast(e.message); }
};
$("#pwForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!passwordOk($("#pwNew").value)) { toast(t("err_pw_rule")); return; }
  try {
    const r = await api("/api/auth/password", { method: "POST", body: { oldPassword: $("#pwOld").value, newPassword: $("#pwNew").value } });
    store.set("token", r.token);
    $("#pwOld").value = ""; $("#pwNew").value = "";
    toast(t("pw_changed"));
  } catch (e) { toast(e.message); }
});
$("#logoutBtn").onclick = async () => {
  if (!(await askConfirm(t("logout_confirm"), t("logout")))) return;
  store.set("token", "");
  location.reload();
};
$("#icsCopyBtn").onclick = async () => {
  const input = $("#icsUrl");
  try { await navigator.clipboard.writeText(input.value); toast(t("copied")); }
  catch { input.select(); toast(t("copy_manual")); }
};
$("#tzDeviceBtn").onclick = () => { $("#tzInput").value = Intl.DateTimeFormat().resolvedOptions().timeZone; };
$("#tzSaveBtn").onclick = async () => {
  try { const r = await api("/api/settings/timezone", { method: "PUT", body: { timezone: $("#tzInput").value.trim() } }); toast(t("tz_saved", { tz: r.timezone })); }
  catch (e) { toast(t("save_failed", { error: e.message })); }
};

// ---------- Claude 对话 ----------
const chatLog = $("#chatLog");
let pendingPhotos = [];
function addMsg(role, text, images = []) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  images.forEach((src) => { const img = document.createElement("img"); img.src = src; img.alt = ""; div.appendChild(img); });
  div.appendChild(document.createTextNode(text));
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}
$("#chatPhotos").addEventListener("change", (ev) => {
  pendingPhotos = [...ev.target.files].slice(0, 5);
  $("#chatPreview").innerHTML = "";
  pendingPhotos.forEach((f) => { const img = document.createElement("img"); img.src = URL.createObjectURL(f); img.alt = ""; $("#chatPreview").appendChild(img); });
});
const chatInput = $("#chatInput");
enterToSend(chatInput, () => $("#chatForm").requestSubmit());
$("#chatForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const text = chatInput.value.trim();
  if (!text && !pendingPhotos.length) return;
  addMsg("user", text, pendingPhotos.map((f) => URL.createObjectURL(f)));
  const fd = new FormData();
  fd.append("message", text);
  fd.append("history", JSON.stringify(state.chatHistory));
  for (const f of pendingPhotos) fd.append("photos", await shrinkForUpload(f));
  chatInput.value = ""; pendingPhotos = []; $("#chatPreview").innerHTML = ""; $("#chatPhotos").value = "";
  const thinking = addMsg("assistant thinking", t("claude_thinking"));
  const submit = ev.target.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const r = await api("/api/chat", { method: "POST", body: fd });
    thinking.remove();
    addMsg("assistant", r.reply);
    state.chatHistory.push({ role: "user", content: text || t("chat_photo_only") }, { role: "assistant", content: r.reply });
    loadMonth();
  } catch (e) { thinking.remove(); addMsg("assistant", t("claude_error", { error: e.message })); }
  submit.disabled = false;
});

// ---------- 登录 / 注册 ----------
let authMode = "login";
function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === "signup";
  $("#tabLogin").setAttribute("aria-selected", String(!signup));
  $("#tabSignup").setAttribute("aria-selected", String(signup));
  $("#authNameRow").hidden = !signup;
  $("#pwRule").hidden = !signup;
  $("#authSubmit").textContent = signup ? t("signup_btn") : t("login_btn");
  $("#authPassword").autocomplete = signup ? "new-password" : "current-password";
  $("#authFootText").textContent = signup ? t("have_acct") : t("no_acct");
  $("#authSwitch").textContent = signup ? t("tab_login") : t("tab_signup");
}
$("#tabLogin").onclick = () => { setAuthMode("login"); $("#authError").textContent = ""; };
$("#tabSignup").onclick = () => { setAuthMode("signup"); $("#authError").textContent = ""; };
$("#authSwitch").onclick = () => { setAuthMode(authMode === "signup" ? "login" : "signup"); $("#authError").textContent = ""; };
$("#pwToggle").onclick = () => { const i = $("#authPassword"); i.type = i.type === "password" ? "text" : "password"; };
function showAuth(message) {
  store.set("token", "");
  document.body.classList.add("locked");
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  $("#authError").textContent = message && !/^401$/.test(message) ? message : "";
  setTimeout(() => $(authMode === "signup" ? "#authName" : "#authEmail").focus(), 50);
}
$("#authForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const err = $("#authError");
  const email = $("#authEmail").value.trim(), password = $("#authPassword").value, name = $("#authName").value.trim();
  err.textContent = "";
  if (authMode === "signup" && !name) { err.textContent = t("err_name"); return; }
  if (!EMAIL_RE.test(email)) { err.textContent = t("err_email"); return; }
  if (authMode === "signup" ? !passwordOk(password) : !password) { err.textContent = t("err_pw_rule"); return; }
  const btn = $("#authSubmit"); btn.disabled = true;
  try {
    const r = await api(`/api/auth/${authMode}`, { method: "POST", body: { email, password, name, lang: getLang() } });
    store.set("token", r.token);
    $("#authPassword").value = "";
    await startApp();
  } catch (e) { err.textContent = e.message; }
  btn.disabled = false;
});

// ---------- 启动 ----------
async function openFromHash() {
  const m = location.hash.match(/^#event-(\d+)$/);
  if (m) await openDetail(Number(m[1]));
}
window.addEventListener("hashchange", openFromHash);
// 双向同步：从我的 Google「共享日历」读回变更，有变更就重画日历
async function pullGoogle() {
  if (!state.me?.google || document.body.classList.contains("locked")) return;
  try {
    const r = await api("/api/google/pull", { method: "POST", body: {} });
    if (r.created || r.updated || r.deleted) {
      await loadMonth();
      if (current) { try { current = await api(`/api/events/${current.id}`); renderDetail(); } catch { closeDetail(); } }
    }
  } catch {}
}
let started = false;
async function startApp() {
  state.me = await api("/api/auth/me");
  if (state.me.lang && state.me.lang !== getLang()) setLang(state.me.lang); // 帐号里存的语言，所有设备一致
  document.body.classList.remove("locked");
  [state.config, state.members] = await Promise.all([api("/api/config"), api("/api/members")]);
  state.labels = state.config.labels || {};
  state.labelNames = state.config.labelNames || {};
  $("#claudeTab").hidden = !state.config.claude; // 没有 API key 就不显示 Claude 页签
  state.view = "calendar"; // 登录后一定先看到日历
  rerenderAll();
  if (!started) {
    started = true;
    if (!state.config.claude) addMsg("assistant", t("claude_disabled"));
    setInterval(() => {
      if (document.body.classList.contains("locked")) return;
      loadMonth().catch(() => {});
      if (current && !$("#photoViewer").open && !$("#postInput").value) api(`/api/events/${current.id}`).then((e) => { current = e; renderDetail(); }).catch(() => {});
    }, 30_000);
    setInterval(() => { if (!document.hidden) pullGoogle(); }, 60_000); // 备用：Google 推送通知之外，每分钟检查一次
    document.addEventListener("visibilitychange", () => { if (!document.hidden) pullGoogle(); });
  }
  await loadMonth();
  pullGoogle();
  const qs = new URLSearchParams(location.search);
  if (qs.has("google") || qs.has("google_error")) {
    history.replaceState(null, "", location.pathname);
    showView("settings");
    setTimeout(() => toast(qs.get("google_error") ? t("g_connect_fail", { error: qs.get("google_error") }) : t("g_connected_toast", { gmail: qs.get("email") || "Google" })), 300);
  } else if (location.hash === "#settings") { history.replaceState(null, "", location.pathname); showView("settings"); }
  else await openFromHash();
}
(function init() {
  applyI18n(document);
  fillLangSelects();
  renderWeekdays();
  setAuthMode("login");
  if (!token()) { showAuth(); return; }
  startApp().catch((e) => { if (!document.body.classList.contains("locked")) toast(t("load_failed", { error: e.message })); });
})();

import { env } from "./env.mts";
// 个人帐号：用 Gmail + 密码注册 / 登录。密码用 scrypt 加盐保存；登录后发一个签名的 token（90 天）。
import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import * as db from "./db.mts";
import { sign, verify } from "./settings.mts";
import { normLang } from "./i18n.mts";

// 登录不会过期：直到在「设置」按「登出」，或修改密码（其他设备会被登出）
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 密码：至少 6 个字，且至少 1 个特殊符号（不是字母、数字、空白）
const PW_RULE = "密码至少 6 个字，并包含 1 个特殊符号（例如 ! @ # $ %）";
export const passwordOk = (pw: string) => pw.length >= 6 && /[^\p{L}\p{N}\s]/u.test(pw);

export class AuthError extends Error {
  status: number;
  constructor(msg: string, status = 401) { super(msg); this.status = status; }
}

function scrypt(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) =>
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key))));
}
async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${(await scrypt(password, salt)).toString("base64")}`;
}
async function checkPassword(password: string, stored: string) {
  const [kind, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const got = await scrypt(password, Buffer.from(salt, "base64"));
  const want = Buffer.from(hash, "base64");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export const normalizeEmail = (e: any) => String(e || "").trim().toLowerCase();
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// token 的签名包含密码 hash 的一部分：改密码后，其他设备的旧登录自动失效
const tokenText = (payload: string, user: any) => `session:${payload}:${String(user.password_hash).slice(-16)}`;
async function makeToken(user: any) {
  const payload = Buffer.from(JSON.stringify({ u: user.id, t: Date.now() })).toString("base64url");
  return `${payload}.${await sign(tokenText(payload, user))}`;
}

/** 注册：Gmail、名字、密码 */
export async function signup(body: any) {
  const email = normalizeEmail(body.email);
  const name = String(body.name || "").trim().slice(0, 40);
  const password = String(body.password || "");
  if (!EMAIL_RE.test(email)) throw new AuthError("请输入正确的 Gmail 地址", 400);
  if (!name) throw new AuthError("请输入你的名字", 400);
  if (!passwordOk(password)) throw new AuthError(PW_RULE, 400);
  if (await db.getUserByEmail(email)) throw new AuthError("这个 Gmail 已经注册过了，请直接登录", 400);
  const user = await db.createUser({ email, name, password_hash: await hashPassword(password), lang: normLang(body.lang) });
  await db.ensureMember(name); // 新成员会出现在「成员」列表
  return { token: await makeToken(user), user: publicUser(user) };
}

/** 登录 */
export async function login(body: any) {
  const email = normalizeEmail(body.email);
  const user = email ? await db.getUserByEmail(email) : null;
  if (!user || !(await checkPassword(String(body.password || ""), user.password_hash))) {
    await delay(800); // 减慢猜密码
    throw new AuthError("Gmail 或密码不正确");
  }
  return { token: await makeToken(user), user: publicUser(user) };
}

/** 从请求取出登录的人（Authorization: Bearer <token>，或照片网址的 ?t=） */
export async function currentUser(req: Request, url: URL) {
  const raw = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || url.searchParams.get("t") || "";
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) throw new AuthError("请先登录");
  let data: any;
  try { data = JSON.parse(Buffer.from(payload, "base64url").toString()); } catch { throw new AuthError("请先登录"); }
  if (!Number.isInteger(data?.u)) throw new AuthError("请重新登录"); // 不检查期限：永久登录
  const user = await db.getUser(data.u);
  if (!user || !(await verify(tokenText(payload, user), sig))) throw new AuthError("请重新登录");
  return user;
}

export async function changePassword(user: any, body: any) {
  if (!(await checkPassword(String(body.oldPassword || ""), user.password_hash))) throw new AuthError("原密码不正确", 400);
  const pw = String(body.newPassword || "");
  if (!passwordOk(pw)) throw new AuthError(PW_RULE, 400);
  await db.setUserPassword(user.id, await hashPassword(pw));
  return { token: await makeToken(await db.getUser(user.id)) };
}

// 管理员：Supabase 函数密钥 ADMIN_EMAILS（逗号分隔的 Gmail）
export const isAdmin = (u: any) => (env("ADMIN_EMAILS") || "").toLowerCase().split(/[,\s]+/).filter(Boolean).includes(String(u?.email || "").toLowerCase());
export const canWhatsApp = (u: any) => isAdmin(u) || !!u?.wa_allowed;
export const publicUser = (u: any) => ({ id: u.id, email: u.email, name: u.name, lang: u.lang || "en", admin: isAdmin(u), can_whatsapp: canWhatsApp(u) });

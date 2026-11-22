# 共享日历 Shared Calendar

一个给家人或小团队用的共享日历：行程、留言和照片、颜色标签、Google 日历双向同步、WhatsApp 提醒客户、Claude 助手。手机可以「加到主画面」当 App 用。

- **网页**：`docs/` → 放在 **GitHub Pages**（免费）
- **后端**：`supabase/` → **Supabase**（免费方案）：资料库（Postgres）、照片（Storage）、API（Edge Function）、排程（pg_cron）

## 结构
```
docs/                       网页（GitHub Pages 发布这个资料夹）
  config.js                 ← 后端网址（Supabase 函数网址）
  index.html / app.js / style.css / i18n.js
  sw.js, manifest.json, icons/   安装成 App
supabase/
  migrations/               资料表 + 安全设定 + 排程
  functions/api/            后端（一个 Edge Function，处理所有 /api/...）
  config.toml               函数设定（App 用自己的登录，所以 verify_jwt = false）
test/local-api.ts           本地测试用
```

后端网址：`https://<项目>.supabase.co/functions/v1/api/...`
- `/api/*` App 的 API · `/api/p/:id` 照片公开链接 · `/api/cal/<签名>.ics` 订阅链接
- `/api/cron/google-pull`（每 30 分钟）· `/api/cron/customer-messages`（每 15 分钟）由资料库排程呼叫

## 部署
1. 在 supabase.com 建立项目（免费）
2. 安装 Supabase CLI，然后：
   ```bash
   supabase link --project-ref <项目 ID>
   supabase db push
   supabase functions deploy api --use-api
   supabase secrets set APP_URL=https://<你的 GitHub 名称>.github.io/<repo 名称>
   ```
3. 把 `docs/config.js` 的 `apiBase` 改成 `https://<项目 ID>.supabase.co/functions/v1`
4. GitHub → Settings → Pages → Deploy from a branch → `main` / `/docs`
5. 打开 App、注册第一个帐号（打开 App 一次后，排程才会开始运作）

## 函数密钥（Supabase → Edge Functions → Secrets）
- `APP_URL`：网页网址（GitHub Pages），例如 `https://tris35.github.io/Shared-calendar`
- `ADMIN_EMAILS`：管理员的 Gmail（逗号分隔），可以设定谁能发 WhatsApp
- `APP_TIMEZONE`：默认 Asia/Kuala_Lumpur（也可以在 App 的「设置」里改）
- `ANTHROPIC_API_KEY`：Claude 助手（可选）
- `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`：Google 日历同步（可选，见下面）
- WhatsApp（可选）：`KAPSO_API_KEY` 或 `WHATSAPP_TOKEN`，加上 `WHATSAPP_PHONE_NUMBER_ID`，可选 `WHATSAPP_TEMPLATE`、`WHATSAPP_TEMPLATE_LANG`、`WHATSAPP_COUNTRY_CODE`、`WHATSAPP_API_VERSION`

## Google 日历同步（双向）
Google Cloud 建立 OAuth 客户端（网页应用），重新导向 URI 填
`https://<项目 ID>.supabase.co/functions/v1/api/google/callback`，再把 `GOOGLE_CLIENT_ID` 和 `GOOGLE_CLIENT_SECRET` 加到函数密钥。
（OAuth 同意画面要按「发布应用」，否则授权 7 天后失效。）
在 App「设置」可以选要双向同步哪一个 Google 日历；Google 上的变更约 30 分钟内（或打开 App 时）同步回 App。
也可以只用「订阅链接」（.ics），不用设定。

## WhatsApp 发给客户
每个行程可以填「客户电话」和「给客户的讯息」，前一天下午 4:00（App 时区）自动发出，排程每 15 分钟检查一次，所以在 4:00–4:15 之间发出。
设定方法：在 Kapso（kapso.ai）或 Meta WhatsApp Business 建立讯息模板 `customer_note`（内容例如 `Hello! A message from us:` 换行 `{{1}}` 换行 `Thank you!`），审核通过后把金钥加到函数密钥。
WhatsApp 规定模板参数不能有换行，所以多行讯息会变成「第一行 | 第二行」。

## 安装成 App（PWA）
- iPhone：用 Safari 打开网站 → 分享 → 「加到主画面」
- Android：用 Chrome 打开 → 菜单 → 「安装应用」

## 本地测试
需要 Deno 和本地 Postgres：
```bash
psql -d cal -f supabase/migrations/20261128000000_init.sql
TEST_DB_URL=postgres://localhost/cal LOCAL_PHOTO_DIR=/tmp/photos API_BASE=http://localhost:8081 APP_URL=http://localhost:8080 \
  deno run -A --config supabase/functions/api/deno.json test/local-api.ts
```
再把 `docs/` 用任何静态网站伺服器打开（`config.js` 的 `apiBase` 改成 `http://localhost:8081`）。

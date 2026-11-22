# 共享日历（Netlify 版）

打开 App 先看到**登录 / 注册**页面：每个人用自己的 **Gmail + 密码** 注册（任何人都可以注册），登录后永久保持（直到在「设置」按「登出」或修改密码）。留言、照片自动显示帐号的名字。

行程 · 时间线（留言 + 照片，显示是谁发的）· 照片评论 · 颜色标签 · Claude 助手 · 自动同步到 Google 日历

## Google 日历同步（双向，不使用 Google Drive）
在 App 新增 / 修改 / 删除行程、发留言或照片，Google 日历会自动更新：
- 标题、时间（含全天、跨天）、颜色标签、成员、备注
- 每则留言和照片评论（谁、什么时候）
- 照片以「看照片」链接列出（Google 日历不能直接显示图片；链接带签名，不用登录就能看那一张）
- 前一天 12:00 由 Google 日历通知
**双向同步**：在「设置 → 同步哪一个日历」可以选 Google 帐号里已有的日历（例如有 TimeTree 资料的「拍摄」）。
它的行程会进入 App，App 的行程也会写进它；之后在 Google 新增、改标题 / 时间 / 颜色、删除，约 10 分钟内（或打开 App 时）同步回 App。
在 Google 删除 = App 里也删除（所有人）。备注、留言、照片请在 App 里改。

两种连接方式（App「设置」页）：
1. **连接 Google 日历**（推荐，每个人各自连接）：填要同步的 Gmail → 按按钮 → 在 Google 画面选**同一个** Gmail 并允许（选错帐号会被拒绝）→ App 在那个 Gmail 的 Google 日历建立「共享日历」，即时更新、有颜色和通知。
   App 管理员要先做一次设定：Google Cloud 建立 OAuth 客户端（网页应用），重新导向 URI 填
   `https://family-calendar-7k3p.netlify.app/api/google/callback`，然后在 Netlify 环境变量加入
   `GOOGLE_CLIENT_ID` 和 `GOOGLE_CLIENT_SECRET`。（OAuth 同意画面要按「发布应用」，否则授权 7 天后失效。）
2. **订阅链接**（免设定）：复制 App 给的 .ics 链接，在 Google 日历「透过网址」新增。Google 每几小时更新一次，没有颜色和通知。

## 结构
- `public/` 网页（手机优先，可加到主屏幕）
- `netlify/functions/api.mts` 所有 API（/api/*），用 `APP_PASSWORD` 保护
- `netlify/functions/photo-link.mts` 照片公开链接（/p/:id，带签名）
- `netlify/functions/calendar-feed.mts` 订阅链接（/cal/<签名>.ics）
- `netlify/functions/google-pull.mts` 每 10 分钟从 Google 读回变更（双向同步）
- `netlify/lib/` 资料库（Netlify Database / Postgres）、Google 日历、Claude
- `netlify/database/migrations/` 资料表（部署时自动建立）
- 照片存在 Netlify Blobs

## 部署（在你自己的电脑）
```bash
npm install
npx netlify-cli login
npx netlify-cli link --id 1e08b34d-3cfd-480b-b27b-8cf0e8b97724
npx netlify-cli deploy --build --prod
```

## Netlify 环境变量
- `APP_PASSWORD`：已不再使用（改成个人帐号），可以删除
- `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`：用 Google 帐号连接（见上）
- `ANTHROPIC_API_KEY`：Claude 助手（可选）
- `APP_TIMEZONE`：默认 Asia/Kuala_Lumpur（也可以在 App 的「设置」里改）

## WhatsApp 发给客户（前一天下午 4 点自动发送）
每个行程可以填「客户电话」和「给客户的讯息」（可多行）。前一天下午 4:00（App 时区）会自动用 WhatsApp 发出；
排程每 5 分钟检查一次，所以会在 4:00–4:05 之间发出。行程页可以「立即发送」或「取消自动发送」。
改了电话、讯息或日期，会再发一次新的。

一次性设定 — 方法 A：Kapso（推荐，较简单）
1. 在 kapso.ai 注册 → 建立 Project → 连接 WhatsApp（会用 Facebook 登录完成 Meta 的商业帐号设定，可选新号码或自己的号码）
2. 在 Kapso 建立讯息模板 `customer_note`（内容同下面第 2 步）→ 等 Meta 审核通过
3. Kapso → API Keys 建立一个 key
4. Netlify 环境变量：`KAPSO_API_KEY`、`WHATSAPP_PHONE_NUMBER_ID`（Kapso 里那个号码的 Phone number ID）

一次性设定 — 方法 B：直接用 Meta WhatsApp Business Cloud API：
1. developers.facebook.com → 建立 App（类型 Business）→ 加入 WhatsApp 产品，绑定你的 Meta 商业帐号和发送用的电话号码
2. WhatsApp Manager → 讯息模板 → 建立模板：名称 `customer_note`，类别 Utility，语言 English，内容例如：
   `Hello! A message from us:` 换行 `{{1}}` 换行 `Thank you!`（{{1}} 不能放在最前面或最后面）→ 等 Meta 审核通过
3. 商业设定 → 系统用户 → 产生永久 Access Token（权限 whatsapp_business_messaging）
4. Netlify 环境变量：
   - `WHATSAPP_TOKEN`：永久 Access Token
   - `WHATSAPP_PHONE_NUMBER_ID`：WhatsApp → API 设定页的 Phone number ID（不是电话号码本身）
   - `WHATSAPP_TEMPLATE`：模板名称（默认 customer_note）
   - `WHATSAPP_TEMPLATE_LANG`：模板语言代码（默认 en；中文模板用 zh_CN）
   - `WHATSAPP_COUNTRY_CODE`：电话没写国码时加上的国码（默认 60 马来西亚）
   - `WHATSAPP_API_VERSION`：默认 v23.0

注意：WhatsApp 规定模板参数不能有换行，所以多行讯息会变成「第一行 | 第二行」。

## 本地测试
`node test/dev-server.mjs`（本地 Postgres + Blobs + 模拟 Google 日历）

## 安装成 App（PWA）
- iPhone：用 Safari 打开网站 → 分享 → 「加到主画面」
- Android：用 Chrome 打开 → 菜单 → 「安装应用」
- `public/sw.js` 只缓存网页本身；`/api`、照片、日历订阅永远从服务器读取。改了设计，下次打开 App 就会更新。

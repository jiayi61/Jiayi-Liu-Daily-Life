# 一键刷新用的小代理（Canvas / Apple iCloud 日历）

Canvas 和 iCloud 都不允许别的网站直接读取「日历订阅」链接，所以日程本要通过一个很小的代理去读。代理跑在 Cloudflare Workers 上，免费额度足够个人使用。

不想部署也没关系：在「📥 导入」里选择从 Canvas 下载、或从 Mac「日历」App 导出的 .ics 文件，效果一样，只是每次要重新下载或导出文件。

## 部署（约 5 分钟）

1. 注册并登录 [Cloudflare](https://dash.cloudflare.com)。
2. 左侧点 **Workers & Pages** → **Create** → **Create Worker**，名字填 `canvas-proxy`，点 **Deploy**。
3. 点 **Edit code**，把 [`canvas-worker.js`](canvas-worker.js) 的内容整个粘贴进去，替换原来的代码，再点 **Deploy**。
   - 如果日程本不是部署在 `https://jiayi61.github.io`，把文件开头 `ALLOWED_ORIGINS` 里的地址改成你自己的。
4. 复制 Worker 的地址，形如 `https://canvas-proxy.xxx.workers.dev`。
5. 打开日程本 → **📥 导入**：
   - 最下面「⚙️ 一键刷新用的代理」：填第 4 步的地址；
   - Canvas 的「设置一键刷新」：在 Canvas 左边点「日历」，右下角点「日历订阅」，复制那个链接；
   - Apple 日历的「设置一键刷新」：iPhone「日历」→ 底部「日历」→ 日历右边的 ⓘ → 打开「公开日历」→「共享链接」→ 拷贝，粘贴 webcal:// 开头的链接。只有 iCloud 日历能这样做。
6. 保存后就会出现 **🔄 一键刷新 Canvas** / **🔄 一键刷新Apple 日历**。

## 安全说明

- 代理只转发 Canvas 日历订阅链接（`…/feeds/calendars/user_….ics`）和 iCloud 公开日历链接（`p…-caldav.icloud.com/published/2/…`），也只回应日程本自己的网页。
- 代理不保存任何东西。订阅链接只存在你自己账号的资料里。
- 订阅链接相当于一把只读钥匙，别人拿到就能看到你的日历。不要把它发给别人。Canvas 链接泄露了可以在 Canvas 个人设置里重置；iCloud 公开日历关掉「公开日历」再打开就会换一个新链接。

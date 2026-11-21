# Jiayi Liu · Daily Life 📒

一个每日日程本风格的个人网站：一天一页，记录日程、待办和心情。登录后数据存在云端（Firebase），手机和电脑自动同步；还能「添加到主屏幕」当 App 用。

## 功能
- **今日日程**：填入每天的时间安排（开始–结束、备注、颜色），可设置「仅这一天 / 每天 / 工作日 / 每周这一天」重复；可勾选完成，当前时段高亮「进行中」，并有现在时刻的时间线。
- **待办清单**：每件事都有截止日期和时间、优先级、标签；自动分组为「已逾期 / 当天截止 / 即将到来 / 当天完成」，并显示倒计时。
- **今日笔记 + 心情**：自动保存。
- **一周概览**：点击周条切换日期；键盘 ← → 切换日期，T 回到今天。
- **云同步**：Google 或邮箱登录，多设备实时同步，断网时照常使用、联网后自动补传。
- **手机 App**：可添加到手机主屏幕，全屏打开，离线可用。
- **备份 / 恢复**：随时导出、导入 JSON 文件。

---

## 一次性设置（约 10 分钟）

### 1. 开启 GitHub Pages
仓库 **Settings → Pages** → Source 选 **Deploy from a branch**，Branch 选 `main`、`/ (root)` → Save。
一两分钟后网址是：`https://jiayi61.github.io/Jiayi-Liu-Daily-Life/`

### 2. 创建 Firebase 项目
1. 打开 <https://console.firebase.google.com>，用你的 Google 账号登录 → **创建项目**（名字随意，例如 `daily-planner`；Google Analytics 可以关掉）。
2. 项目首页点 **`</>`（网页）** 图标添加一个 Web 应用，名字随意，**不用**勾选 Firebase Hosting。
3. 页面上会出现一段 `const firebaseConfig = { apiKey: ..., ... }`，把里面的 6 个值复制到本仓库的 **`firebase-config.js`** 对应位置。
   这些值本来就会出现在网页里，不是密码，可以放心提交到 GitHub。

### 3. 开启登录方式
左侧 **Build → Authentication → 开始使用 → Sign-in method**：
- 开启 **Google**（选一个支持邮箱即可）。
- 开启 **电子邮件/密码**（手机主屏幕 App 里如果 Google 登录弹窗打不开，用这个）。

然后在 Authentication → **Settings → 已获授权的网域** 里点「添加网域」，加上：`jiayi61.github.io`

### 4. 创建数据库并设置安全规则
1. 左侧 **Build → Firestore Database → 创建数据库**，位置选离你近的（例如 `nam5 (us-central)`），以**生产模式**启动。
2. 打开 **规则（Rules）** 标签，把内容整个替换成本仓库 [`firestore.rules`](firestore.rules) 里的内容 → **发布**。
   这条规则保证每个人只能读写自己的数据。

### 5.（可选）只允许你自己登录
在 `firebase-config.js` 的 `ALLOWED_EMAILS` 里填上你的邮箱，例如 `["you@gmail.com"]`。

完成后提交 `firebase-config.js`，刷新网页，右上角点 **Google 登录** 即可。第一次登录时，浏览器里已有的数据会自动上传到云端。

---

## 装到手机上
- **iPhone**：用 Safari 打开网址 → 底部「分享」按钮 → **添加到主屏幕**。
- **安卓**：用 Chrome 打开 → 右上角菜单 → **安装应用 / 添加到主屏幕**。

> 在 iPhone 主屏幕 App 里第一次需要单独登录一次（它和 Safari 的登录状态是分开的）。

## 数据结构（为以后做原生 App / 推送提醒预留）
Firestore 中每一项单独一个文档：
```
users/{uid}/todos/{id}    title, due, dueAt(时间戳), prio, tag, done, doneAt, createdAt
users/{uid}/events/{id}   title, start, end, note, color, repeat, date, skip[], doneOn[]
users/{uid}/days/{日期}    note, mood
```
`dueAt` 是真正的时间戳字段，以后可以直接用它查询「1 小时内到期的待办」来发推送。

## 和 Claude 聊天时直接记待办
`mcp/` 文件夹里是一个 MCP 工具，装好后在 Claude 桌面应用里说"帮我记一下周五前交作业"，就会直接写进日程本。安装方法见 [mcp/README.md](mcp/README.md)。

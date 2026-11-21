# Jiayi Liu · Daily Life 📒

一个每日日程本风格的个人网站：一天一页，记录日程、待办和心情。登录后数据存在云端（Firebase），手机和电脑自动同步；还能「添加到主屏幕」当 App 用。

## 功能
- **今日日程（整天日历）**：像苹果日历一样，一天从早上 5:00 到第二天凌晨 5:00。点空白处或拖一段新建，拖动日程改时间，拖底边改时长（手机上先长按再拖）；重叠的日程并排显示；可设置「仅这一天 / 每天 / 工作日 / 每周」重复，勾选完成。
- **日程标签**：第一次登录时选身份（学生、研究生、上班族…），自动推荐一组按优先级排好的标签；之后在「🏷 标签」里增删、改名、调顺序。
- **⏱ 这周的时间**：按标签统计这周打了勾的日程花了多少小时，和计划时长、上周对比。
- **待办清单**：截止日期和时间可以不设（放进「没有截止日期」一组）；有优先级、标签；可以拆成小任务，显示完成度，小任务全勾完自动完成；自动分组为「已逾期 / 当天截止 / 即将到来 / 没有截止日期 / 当天完成」，并显示倒计时。
- **今日笔记 + 心情**：自动保存。
- **一周概览**：点击周条切换日期；键盘 ← → 切换日期，T 回到今天。
- **云同步**：Google 或邮箱登录，多设备实时同步，断网时照常使用、联网后自动补传。
- **手机 App**：可添加到手机主屏幕，全屏打开，离线可用。
- **备份 / 恢复**：随时导出、导入 JSON 文件。
- **📦 每周回顾**：一键复制这一周的日程、待办、笔记和心情，粘贴给任意 AI（DeepSeek、豆包、ChatGPT…）聊 5 分钟；再把 AI 的回复粘贴回来，自动识别里面的清单行，勾选确认后加入。
- **📚 清单（侧栏）**：电影、书、餐厅、礼物、城市，也可以自己新建清单。可以手动添加，也可以从每周回顾导入。
- **垃圾箱**：删除的日程和待办先进垃圾箱，30 天内可恢复；删除后还能立刻点「撤销」。
- **每个人自己的称呼**：第一次登录时填写一个称呼，点右上角名字可以修改。

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
users/{uid}/todos/{id}    title, due(可为空), dueAt(时间戳，有截止时才有), prio, tag, subs[{id,title,done}], done, doneAt, createdAt
users/{uid}/events/{id}   title, start, end, note, cat(标签 id), color, repeat, date, skip[], doneOn[]
users/{uid}/days/{日期}    note, mood
users/{uid}/lists/{id}     type, name, date, note, city?, person?, occasion?, createdAt
users/{uid}/listTypes/{id} label, icon（自己新建的清单）
users/{uid}/meta/profile  nickname, role, categories[{id, emoji, label, color}]（第一次登录时填写，标题显示「称呼's Daily Planner」）
```
删除的条目带 `deletedAt`（在垃圾箱里，30 天后自动清除）。
`dueAt` 是真正的时间戳字段，以后可以直接用它查询「1 小时内到期的待办」来发推送。

## 和 Claude 聊天时直接记待办
`mcp/` 文件夹里是一个 MCP 工具，装好后在 Claude 桌面应用里说"帮我记一下周五前交作业"，就会直接写进日程本。安装方法见 [mcp/README.md](mcp/README.md)。

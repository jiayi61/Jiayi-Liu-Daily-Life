# Daily Planner MCP 工具

让 Claude 在聊天时直接读写日程本（同一个 Firestore 数据库）。

工具：`add_todo`、`list_todos`、`complete_todo`、`update_todo`、`delete_todo`、`add_schedule_item`、`list_schedule`、`delete_schedule_item`。

## 安装（在这台 Mac 上已装好）
```bash
mkdir -p ~/.daily-planner-mcp && cp server.js package.json ~/.daily-planner-mcp/
cd ~/.daily-planner-mcp && npm install
```
把 Firebase「项目设置 → 服务账号 → 生成新的私钥」下载的文件放到 `~/.daily-planner-mcp/service-account.json`，并 `chmod 600`。
**这个密钥能读写全部数据，绝不能提交到 GitHub。**

Claude 桌面应用：在 `~/Library/Application Support/Claude/claude_desktop_config.json` 加入：
```json
"mcpServers": {
  "daily-planner": {
    "command": "/usr/local/bin/node",
    "args": ["/Users/<你>/.daily-planner-mcp/server.js"],
    "env": {
      "PLANNER_SERVICE_ACCOUNT": "/Users/<你>/.daily-planner-mcp/service-account.json",
      "PLANNER_UID": "<Firebase Auth 里你的 uid>",
      "TZ": "America/New_York"
    }
  }
}
```
Claude Code：`claude mcp add -s user daily-planner -e PLANNER_SERVICE_ACCOUNT=... -e PLANNER_UID=... -- node ~/.daily-planner-mcp/server.js`

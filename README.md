# BB MCP

面向 University of Bristol Blackboard 的本地 Playwright MCP。使用独立的 Microsoft Edge 登录资料，支持登录、页面快照、点击、填写、下载、标签页切换和英国本地学年周次查询。

## 安装与连接

当前版本用于 Windows，需要 Node.js 和 Microsoft Edge。

```powershell
git clone https://github.com/UKplus8HRS/bb-mcp.git
cd bb-mcp/mcp
npm.cmd ci
```

在 MCP 客户端中使用 stdio，命令为 `node`，参数为克隆目录下 `mcp/server.js` 的绝对路径。例如 Codex 的 `config.toml`：

```toml
[mcp_servers.blackboard_playwright]
command = "node"
args = ['C:\path\to\bb-mcp\mcp\server.js']
startup_timeout_sec = 60
tool_timeout_sec = 90
```

调用 `blackboard_login` 后，在打开的 Edge 中完成学校账号登录和 MFA。登录资料保存在用户目录的 `.codex/blackboard-browser/edge-profile`；下载文件保存在系统临时目录的 `codex-blackboard-downloads`。

## 工具与归档

- `blackboard_login`、`blackboard_academic_week`：登录状态与周次查询。
- `blackboard_snapshot`、`blackboard_open`：读取或打开学校页面。
- `blackboard_click`、`blackboard_type`、`blackboard_press`：页面交互。
- `blackboard_download`、`blackboard_screenshot`：下载和截图。
- `blackboard_tabs`、`blackboard_close`：切换标签页和关闭浏览器。

`scripts/archive-blackboard-file.mjs` 可将临时下载文件归档到本项目的 `materials/`，复用相同内容，并为不同内容保留新版本：

```powershell
node scripts/archive-blackboard-file.mjs <临时文件路径> <课程> <章节> <原始文件名>
```

仓库只包含代码，不包含课件、账号密码或浏览器登录资料。学年周次目前固定为 2026–2027 标准学年；具体课程安排以课程页面及课表为准。

## 验证

在仓库根目录运行：

```powershell
node mcp/server.js --self-test
node --test scripts/archive-blackboard-file.test.mjs
```

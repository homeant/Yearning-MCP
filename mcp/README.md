# yearning-mcp

一个 **MCP 服务**，让支持 MCP 的客户端（Claude Desktop / Claude Code 等）通过 **Yearning API** 查询数据库数据。

- 传输：**stdio**，可用 `npx` 运行
- 不直连数据库，全部经 Yearning 接口（复用其权限、字段脱敏与查询审计）
- 接口契约对齐 Yearning **v3.1.9**

## 暴露的能力

**Tools**
| 工具 | 入参 | 作用 |
|------|------|------|
| `list_sources` | — | 列出可查询数据源（source_id / source / idc） |
| `list_databases` | `source_id` | 列出库 |
| `list_tables` | `source_id`, `schema` | 列出表 |
| `query` | `source_id`, `schema`, `sql` | 执行 SQL，返回 markdown 表格 |

**Resources**（只读浏览）
- `yearning://sources`
- `yearning://{sourceId}/databases`
- `yearning://{sourceId}/{schema}/tables`

## 配置（环境变量）

| 变量 | 必填 | 说明 |
|------|------|------|
| `YEARNING_ENDPOINT` | ✅ | Yearning 地址，如 `http://127.0.0.1:8000` |
| `YEARNING_TOKEN` | 二选一 | 已有 JWT（优先） |
| `YEARNING_USERNAME` / `YEARNING_PASSWORD` | 二选一 | 启动时自动登录换取 token |
| `YEARNING_LDAP` | 否 | `true` 时用 LDAP 登录（走 `/ldap`） |

> 提供 `YEARNING_TOKEN` 即可；没有 token 时则用用户名/密码自动登录。

## 在 Claude Desktop / Claude Code 中接入

构建后用本地路径运行（开发期）：

```bash
cd mcp && npm install && npm run build
```

Claude Desktop 配置（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "yearning": {
      "command": "node",
      "args": ["/Users/tianhui/Project/tianhui/Yearning-cli/mcp/dist/index.js"],
      "env": {
        "YEARNING_ENDPOINT": "http://127.0.0.1:8000",
        "YEARNING_USERNAME": "admin",
        "YEARNING_PASSWORD": "你的密码"
      }
    }
  }
}
```

Claude Code（命令行）：

```bash
claude mcp add yearning \
  -e YEARNING_ENDPOINT=http://127.0.0.1:8000 \
  -e YEARNING_USERNAME=admin -e YEARNING_PASSWORD=你的密码 \
  -- node /Users/tianhui/Project/tianhui/Yearning-cli/mcp/dist/index.js
```

发布到 npm 后，可直接用 npx 运行：

```json
{
  "mcpServers": {
    "yearning": {
      "command": "npx",
      "args": ["-y", "yearning-mcp"],
      "env": { "YEARNING_ENDPOINT": "http://127.0.0.1:8000", "YEARNING_TOKEN": "eyJ..." }
    }
  }
}
```

## 开发

```bash
npm install
npm run build        # 编译到 dist/
npm test             # 端到端测试（假 Yearning 服务端，含 WebSocket msgpack 往返）
npm run dev          # tsc --watch
```

## 限制 / 注意

- 执行查询依赖 Yearning 的 SQL 审核 RPC 服务在线，否则返回 `查询出错：rpc调用失败`。
- 若 Yearning 开启了查询审核，需管理员批准查询工单后才能查询。
- stdio 模式下严禁向 stdout 打印日志（会破坏 JSON-RPC），本服务所有日志走 stderr。

# Yearning MCP

一个 **MCP 服务**，让支持 MCP 的客户端（Claude Desktop / Claude Code 等）通过 **Yearning** 的 HTTP/WebSocket 接口查询数据库数据，并提交/审批 Yearning 工单——**不直连数据库**，复用 Yearning 的权限控制、字段脱敏、查询审计与工单流程。接口契约对齐 Yearning **v3.1.9**。

> 已发布到 npm：[`yearning-mcp`](https://www.npmjs.com/package/yearning-mcp)

## 快速接入

在 Claude Desktop / Claude Code 里用 `npx` 直接运行（stdio），无需克隆构建：

```jsonc
// claude_desktop_config.json
{
  "mcpServers": {
    "yearning": {
      "command": "npx",
      "args": ["-y", "yearning-mcp"],
      "env": {
        "YEARNING_ENDPOINT": "http://127.0.0.1:8000",
        "YEARNING_USERNAME": "admin",
        "YEARNING_PASSWORD": "你的密码"
      }
    }
  }
}
```

完整工具列表、工单提交流程、环境变量与本地开发见 [mcp/README.md](mcp/README.md)。

## 前提

- 一个**已完整部署并运行**的 Yearning v3.1.9（含 SQL 审核 RPC 服务，否则查询会报 `rpc调用失败`）。
- 一个有相应数据源**查询权限**的 Yearning 账号。
- 若 Yearning 开启了查询审核，执行查询前需管理员批准查询工单。
- 提交/审批 SQL 工单需要账号具备对应 DDL/DML 数据源权限或审批权限；最后一步审批同意会由 Yearning 执行工单 SQL。

## 开发与测试

```bash
cd mcp
npm install
npm test    # 端到端测试（进程内假 Yearning 服务端，含 WebSocket msgpack 往返）
```

> 工具链由 asdf 的 `.tool-versions` 管理（nodejs 20.20.0）。

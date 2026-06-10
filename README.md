# Yearning Tools

围绕 [Yearning](https://github.com/cookieY/Yearning)（v3.1.9）的两个客户端工具，**都只通过 Yearning 的 HTTP/WebSocket 接口访问，不直连数据库**，从而复用 Yearning 的权限控制、字段脱敏与查询审计。

| 子项目 | 语言 | 形态 | 说明 |
|--------|------|------|------|
| [`cli/`](cli/) | Go | 命令行工具 | 终端里登录、列数据源/库/表、执行查询 |
| [`mcp/`](mcp/) | TypeScript | MCP 服务（stdio，可 npx） | 给 Claude Desktop / Claude Code 等 MCP 客户端调用 |

两者实现各自独立的 Yearning API 客户端，但对齐同一套接口契约。

## 目录结构

```
.
├── cli/            # Go CLI（独立 go.mod）
│   ├── cmd/        #   cobra 命令
│   └── internal/   #   client / config / render
├── mcp/            # TypeScript MCP 服务（独立 package.json）
│   └── src/        #   config / client / server / index
└── .tool-versions  # asdf：golang + nodejs
```

## 快速开始

### CLI（Go）

```bash
cd cli
go build -o yearning-cli .
./yearning-cli config set -e http://127.0.0.1:8000
./yearning-cli config set --username admin --password 'secret'   # LDAP 加 --ldap
./yearning-cli source list                                       # 首次自动登录并缓存 token
./yearning-cli query -s <source_id> -d <库> "SELECT * FROM t LIMIT 10"
```

> 无需单独 login：配置好凭据后按需自动登录，token 过期或被 401 时自动重登。

详见 [cli/README.md](cli/README.md)。

### MCP（TypeScript）

已发布到 npm，在 Claude Desktop / Claude Code 里用 `npx` 直接接入（stdio），无需克隆构建：

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

详见 [mcp/README.md](mcp/README.md)。

## 共同前提

- 一个**已完整部署并运行**的 Yearning v3.1.9（含 SQL 审核 RPC 服务，否则查询会报 `rpc调用失败`）。
- 一个有相应数据源**查询权限**的 Yearning 账号。
- 若 Yearning 开启了查询审核，执行查询前需管理员批准查询工单。

## 开发与测试

```bash
# CLI
cd cli && go test ./...

# MCP
cd mcp && npm test
```

> 工具链由 asdf 的 `.tool-versions` 管理（golang 1.25.0、nodejs 20.20.0）。在对应子目录下执行命令即可。

# yearning-cli

一个通过 **Yearning API**（v3.1.9）查询数据库数据的命令行工具。

它**不直连数据库**：登录、列数据源、列库表、执行 SQL 全部经由 Yearning 服务完成，
因此自动复用 Yearning 的权限控制、字段脱敏（InsulateWordList）与查询审计/录制。

> 仅实现查询功能。DDL/DML 工单暂不支持。

## 工作原理

| 步骤 | Yearning 接口 | 说明 |
|------|--------------|------|
| 登录 | `POST /login` | 用户名密码换取 JWT（有效期 8h） |
| 数据源 | `GET /api/v2/fetch/source` (`tp=query`) | 当前用户可查询的数据源 |
| 库 | `GET /api/v2/query/schema` | `SHOW DATABASES` |
| 表 | `GET /api/v2/query/tables` | `SHOW TABLES` |
| 建查询工单 | `POST /api/v2/query/post` | 关闭审核时自动批准（status=2） |
| 执行查询 | `WS /api/v2/query/results` | msgpack 协议；经 SQL 审核 RPC 与脱敏 |

- HTTP 请求鉴权头：`Authorization: Bearer <token>`
- WebSocket 鉴权头：`Sec-WebSocket-Protocol: <token>`（原始 token）

### 前置条件

- 一个**已完整部署并运行**的 Yearning（含 SQL 审核 RPC 服务，否则查询会报 `rpc调用失败`）。
- 一个有对应数据源**查询权限**的 Yearning 账号。
- 若 Yearning **开启了查询审核**，执行查询前需管理员批准查询工单；本工具会在未批准时给出提示。

## 安装

```bash
cd cli            # 仓库根下的 cli 子目录
go build -o yearning-cli .
# 可选：放入 PATH
# mv yearning-cli /usr/local/bin/
```

## 使用

```bash
# 0) 配置服务端地址与登录凭据（无需单独 login，命令会按需自动登录）
yearning-cli config set -e http://127.0.0.1:8000            # 服务端地址 → config.toml
yearning-cli config set --username admin --password 'secret'        # 凭据 → credentials.json(0600)
yearning-cli config set --username alice --password 'secret' --ldap # LDAP 账号
#   也可手工编辑 ~/.yearning-cli/config.toml
yearning-cli config show                                    # 查看配置、文件路径、token 过期时间

# 1) 列出可查询数据源（首次会自动登录并缓存 token）
yearning-cli source list

# 3) 列出库 / 表
yearning-cli db list -s <source_id>
yearning-cli table list -s <source_id> -d <库名>

# 4) 执行查询
yearning-cli query -s <source_id> -d <库名> "SELECT * FROM users LIMIT 10"

# SQL 也可来自文件或标准输入
yearning-cli query -s <source_id> -d <库名> --file q.sql
echo "SELECT NOW()" | yearning-cli query -s <source_id> -d <库名>

# 输出格式：table（默认）/ json / csv
yearning-cli query -s <source_id> -d <库名> -f json "SELECT * FROM users LIMIT 5"
```

## 配置与环境变量

配置拆成两份，默认都在 `~/.yearning-cli/` 下：

| 文件 | 内容 | 权限 | 是否可共享 |
|------|------|------|-----------|
| `config.toml` | `endpoint`（服务端地址） | 0644 | ✅ 可提交/共享，可手工编辑 |
| `credentials.json` | `username`/`password`/`ldap` + 缓存 `token`/`token_exp` | 0600 | ❌ 切勿提交 |

**鉴权方式**：CLI 不再有单独的 `login` 命令。配置好用户名/密码后，需要鉴权的命令会**按需自动登录**，并把 token 与过期时间缓存进 `credentials.json`；后续命令复用缓存 token，**本地判断过期或被服务端 401 时自动重新登录**。也可只用环境变量 `YEARNING_TOKEN`（不自动刷新）。

> token 与服务端地址**分开存储**：可共享的配置不含密钥，凭据单独以 0600 保存，降低误提交泄露风险。

覆盖优先级：命令行 flag > 环境变量 > 配置文件。

| 变量 | 作用 |
|------|------|
| `YEARNING_ENDPOINT` | Yearning 地址 |
| `YEARNING_USERNAME` | 登录用户名（启用自动登录/重登） |
| `YEARNING_PASSWORD` | 登录密码 |
| `YEARNING_LDAP` | `true` 时走 LDAP 登录 |
| `YEARNING_TOKEN` | 固定 JWT（提供则不自动刷新、不落盘） |
| `YEARNING_CLI_CONFIG` | config.toml 路径 |
| `YEARNING_CLI_CREDENTIALS` | credentials.json 路径 |

```bash
# 用账号密码（支持自动重登）
export YEARNING_ENDPOINT=http://127.0.0.1:8000
export YEARNING_USERNAME=admin YEARNING_PASSWORD=secret
yearning-cli source list
```

### `config` 子命令

```bash
yearning-cli config init [-e URL] [--force]                  # 生成 config.toml 模板
yearning-cli config set  -e URL                              # 设置服务端地址
yearning-cli config set  --username U --password P [--ldap]  # 设置登录凭据
yearning-cli config show                                     # 显示有效配置（密码/token 脱敏）
```

## 开发

```bash
go test ./...    # 单元测试（含 WebSocket msgpack 往返）
go vet ./...
```

## 说明 / 限制

- 查询结果中的敏感字段由 Yearning 按数据源的脱敏配置替换为占位符。
- 单个 BLOB 字段超过约 1MB 时，Yearning 返回不可显示占位符。
- 执行查询依赖 Yearning 的 SQL 审核 RPC 服务在线。
- 与 Yearning **v3.1.9** 的接口契约对齐；其它版本若改动接口可能需适配。

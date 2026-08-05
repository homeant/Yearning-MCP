# yearning-mcp

一个 **MCP 服务**，让支持 MCP 的客户端（Claude Desktop / Claude Code 等）通过 **Yearning API** 查询数据库数据，并提交/审批 Yearning 工单。

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
| `query` | `source_id`, `schema`, `sql` | 执行只读查询 SQL，返回 JSON（多结果集时为数组的数组） |
| `submit_query_order` | `source_id`, `reason`, `export` | 显式提交查询工单 |
| `list_query_orders` | 可选过滤条件 | 列出查询工单（默认待当前账号审批） |
| `review_query_order` | `work_id`, `action` | 同意或驳回查询工单 |
| `list_order_sources` | `order_type` | 列出可提交 SQL 审核工单的数据源 |
| `check_sql_order` | `source_id`, `schema`, `sql`, `order_type` | 提交前调用 Yearning 审核引擎检测 SQL |
| `submit_sql_order` | `source_id`, `schema`, `table`, `sql`, `reason`, `order_type` | 提交 DDL/DML SQL 审核工单 |
| `list_sql_orders` | 可选过滤条件 | 列出 SQL 审核工单（默认待当前账号审批） |
| `review_sql_order` | `work_id`, `action`, `source_id`, `current_step` | 同意或驳回 SQL 审核工单 |

**Resources**（只读浏览）
- `yearning://sources`
- `yearning://{sourceId}/databases`
- `yearning://{sourceId}/{schema}/tables`

**标准查询顺序**

1. 先用 `list_sources` 或 `yearning://sources` 获取数据源，拿到 `source_id`。
2. 再用 `list_databases` 获取库名（schema）。
3. 需要浏览表时用 `list_tables`。
4. 最后用 `query` 执行只读 SQL。

`source_id` 不能用库名、数据源中文名或 IDC 代替；如果不知道 `source_id`，不要猜，先获取数据源列表。

**SQL 工单顺序**

1. 用 `list_order_sources({ order_type })` 获取有 DDL/DML 权限的数据源，拿到 `source_id`。
2. 用 `check_sql_order({ source_id, schema, sql, order_type })` 做提交前检测。
3. 用 `submit_sql_order(...)` 提交工单。
4. 审批人用 `list_sql_orders({ scope: "assigned" })` 找到 `work_id`、`source_id`、`current_step`。
5. 用 `review_sql_order(...)` 同意或驳回。

> 注意：SQL 工单最后一个审批节点 `action=agree` 时，Yearning 会执行该工单 SQL。

## 配置（环境变量）

| 变量 | 必填 | 说明 |
|------|------|------|
| `YEARNING_ENDPOINT` | ✅ | Yearning 地址，如 `http://127.0.0.1:8000` |
| `YEARNING_TOKEN` | 二选一 | 已有 JWT（优先） |
| `YEARNING_USERNAME` / `YEARNING_PASSWORD` | 二选一 | 启动时自动登录换取 token |
| `YEARNING_LDAP` | 否 | `true` 时用 LDAP 登录（走 `/ldap`） |

> 提供 `YEARNING_TOKEN` 即可；没有 token 时则用用户名/密码自动登录。

## 在 Claude Desktop / Claude Code 中接入

已发布到 npm，推荐用 `npx` 直接运行，无需克隆仓库或本地构建。

Claude Desktop 配置（`claude_desktop_config.json`）：

```json
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

Claude Code（命令行）：

```bash
claude mcp add yearning \
  -e YEARNING_ENDPOINT=http://127.0.0.1:8000 \
  -e YEARNING_USERNAME=admin -e YEARNING_PASSWORD=你的密码 \
  -- npx -y yearning-mcp
```

> LDAP 登录追加 `-e YEARNING_LDAP=true`；或用 `-e YEARNING_TOKEN=eyJ...` 直接提供 token。

<details>
<summary>本地源码运行（开发期）</summary>

```bash
cd mcp && npm install && npm run build
```

把上面配置里的 `"command": "npx"` / `"args": ["-y", "yearning-mcp"]` 换成
`"command": "node"` / `"args": ["/<绝对路径>/mcp/dist/index.js"]` 即可。

</details>

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
- SQL 工单检测、最终审批执行同样依赖 Yearning 的审核 RPC 服务在线。
- stdio 模式下严禁向 stdout 打印日志（会破坏 JSON-RPC），本服务所有日志走 stderr。

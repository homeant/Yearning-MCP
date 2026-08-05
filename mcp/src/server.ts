// 组装 MCP server：暴露查询与库表浏览工具，以及对应的只读 resources。

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { YearningClient } from "./client.js";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(err: unknown) {
  return {
    content: [{ type: "text" as const, text: `错误：${(err as Error).message ?? String(err)}` }],
    isError: true,
  };
}

export function buildServer(client: YearningClient): McpServer {
  const server = new McpServer(
    { name: "yearning-mcp", version: "0.1.2" },
    {
      instructions:
        "Yearning 查询和工单都必须使用 source_id。source_id 不是库名，也不是数据源中文名；查询前如果用户没有明确给出 source_id，必须先调用 list_sources 或读取 yearning://sources；提交 SQL 工单前必须先调用 list_order_sources。不要猜测或编造 source_id。query 只用于只读查询；INSERT/UPDATE/DELETE/DDL 必须走 check_sql_order 和 submit_sql_order。review_sql_order 在最后审批节点同意时会触发 Yearning 执行 SQL，必须只在用户明确要求审批/执行时调用。",
    }
  );

  // ---- Tools ----

  server.registerTool(
    "list_sources",
    {
      title: "列出数据源",
      description:
        "列出当前用户在 Yearning 中有查询权限的数据源，返回 source_id / source / idc。查询前如果不知道 source_id，第一步必须调用本工具；source_id 是后续 list_databases、list_tables、query 的必填值。",
      inputSchema: {},
    },
    async () => {
      try {
        const sources = await client.listSources();
        return textResult(JSON.stringify(sources, null, 2));
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "list_databases",
    {
      title: "列出库",
      description:
        "列出指定数据源下的数据库（schema）。如果还不知道 source_id，必须先调用 list_sources 获取；不要把数据源名称、IDC 或库名当作 source_id。",
      inputSchema: {
        source_id: z.string().describe("数据源 source_id，必须来自 list_sources 或 yearning://sources"),
      },
    },
    async ({ source_id }) => {
      try {
        const dbs = await client.listSchemas(source_id);
        return textResult(JSON.stringify(dbs, null, 2));
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "list_tables",
    {
      title: "列出表",
      description:
        "列出指定数据源、指定库下的表。source_id 必须来自 list_sources 或 yearning://sources；schema 必须来自 list_databases 或用户明确指定。",
      inputSchema: {
        source_id: z.string().describe("数据源 source_id，必须来自 list_sources 或 yearning://sources"),
        schema: z.string().describe("库名/schema，通常来自 list_databases"),
      },
    },
    async ({ source_id, schema }) => {
      try {
        const tables = await client.listTables(source_id, schema);
        return textResult(JSON.stringify(tables, null, 2));
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "list_order_sources",
    {
      title: "列出工单数据源",
      description:
        "列出当前用户可提交 SQL 审核工单的数据源。order_type=ddl 返回 DDL 权限数据源，dml 返回 DML 权限数据源，all 返回全部数据源。",
      inputSchema: {
        order_type: z.enum(["ddl", "dml", "all"]).default("all").describe("工单类型对应的数据源权限范围"),
      },
    },
    async ({ order_type }) => {
      try {
        const sources = await client.listOrderSources(order_type);
        return textResult(JSON.stringify(sources, null, 2));
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "check_sql_order",
    {
      title: "检测 SQL 工单",
      description:
        "提交 DDL/DML 工单前调用 Yearning 审核引擎检测 SQL。order_type=ddl 对应 0，dml 对应 1；source_id 必须来自 list_order_sources。",
      inputSchema: {
        source_id: z.string().describe("数据源 source_id，必须来自 list_order_sources"),
        schema: z.string().describe("库名/schema"),
        sql: z.string().describe("待检测 SQL"),
        order_type: z.enum(["ddl", "dml"]).describe("SQL 工单类型"),
        work_id: z.string().optional().describe("已有工单号；新提交前检测通常留空"),
      },
    },
    async ({ source_id, schema, sql, order_type, work_id }) => {
      try {
        const records = await client.checkSqlOrder(source_id, schema, sql, order_type === "ddl" ? 0 : 1, work_id ?? "");
        return textResult(JSON.stringify(records, null, 2));
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "submit_sql_order",
    {
      title: "提交 SQL 工单",
      description:
        "通过 Yearning 提交 DDL/DML SQL 审核工单。提交前建议先调用 check_sql_order；source_id 必须来自 list_order_sources。",
      inputSchema: {
        source_id: z.string().describe("数据源 source_id，必须来自 list_order_sources"),
        schema: z.string().describe("库名/schema"),
        table: z.string().describe("表名；多表或 DDL 无单表时填写主要表名或说明"),
        sql: z.string().describe("待审核 SQL"),
        reason: z.string().describe("提交原因/说明"),
        order_type: z.enum(["ddl", "dml"]).describe("SQL 工单类型"),
        backup: z.boolean().default(false).describe("是否需要备份，通常 DML 可按需开启"),
        delay: z.string().optional().describe("Yearning 延迟执行标记；默认 none"),
        execute_time: z.string().optional().describe("延迟执行时间，格式通常为 YYYY-MM-DD HH:mm"),
        relevant: z.array(z.string()).optional().describe("相关人员 username 列表"),
      },
    },
    async ({ source_id, schema, table, sql, reason, order_type, backup, delay, execute_time, relevant }) => {
      try {
        const result = await client.submitSqlOrder({
          source_id,
          data_base: schema,
          table,
          sql,
          text: reason,
          type: order_type === "ddl" ? 0 : 1,
          backup: backup ? 1 : 0,
          delay,
          execute_time,
          relevant,
        });
        return textResult(JSON.stringify(result, null, 2));
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "list_sql_orders",
    {
      title: "列出 SQL 工单",
      description:
        "列出 SQL 审核工单。scope=assigned 返回待当前账号审批的工单，scope=mine 返回当前账号提交的工单。状态值沿用 Yearning：2 待审批，0 驳回，3/4/5/6 为执行/终止相关状态，8 表示全部。",
      inputSchema: {
        scope: z.enum(["assigned", "mine"]).default("assigned").describe("列表视角"),
        status: z.number().int().optional().describe("工单状态；assigned 默认 2，mine 默认 8"),
        order_type: z.enum(["ddl", "dml", "all"]).default("all").describe("工单类型过滤"),
        work_id: z.string().optional().describe("按工单号模糊过滤"),
        text: z.string().optional().describe("按说明模糊过滤"),
        username: z.string().optional().describe("按提交人 username 过滤"),
        current: z.number().int().positive().default(1).describe("页码"),
        page_size: z.number().int().positive().max(100).default(20).describe("每页数量"),
      },
    },
    async ({ scope, status, order_type, work_id, text, username, current, page_size }) => {
      try {
        const type = order_type === "all" ? 2 : order_type === "ddl" ? 0 : 1;
        const result = await client.listSqlOrders(scope, { status, type, work_id, text, username }, current, page_size);
        return textResult(JSON.stringify(result, null, 2));
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "review_sql_order",
    {
      title: "审批 SQL 工单",
      description:
        "同意或驳回 SQL 审核工单。注意：如果当前审批节点是最后一步，action=agree 会触发 Yearning 执行该工单 SQL；必须在用户明确要求审批/执行时调用。",
      inputSchema: {
        work_id: z.string().describe("SQL 工单号"),
        action: z.enum(["agree", "reject"]).describe("agree=同意，reject=驳回"),
        source_id: z.string().optional().describe("工单 source_id；同意时需要用于匹配审批流程"),
        current_step: z.number().int().positive().default(1).describe("工单当前审批节点 current_step；通常来自 list_sql_orders"),
        reason: z.string().optional().describe("驳回原因；同意时可留空"),
      },
    },
    async ({ work_id, action, source_id, current_step, reason }) => {
      try {
        const result = await client.reviewSqlOrder({ work_id, action, source_id, current_step, reason });
        return textResult(JSON.stringify(result, null, 2));
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "query",
    {
      title: "执行 SQL 查询",
      description:
        "通过 Yearning 执行一条【只读查询】SQL（SELECT/SHOW/DESC/EXPLAIN 等 DQL），返回 JSON。会经过 Yearning 的 SQL 审核与字段脱敏。\n" +
        "调用前必须已经知道 source_id 和 schema：source_id 来自 list_sources 或 yearning://sources；schema 来自 list_databases 或用户明确指定。如果不知道 source_id，先调用 list_sources，不要猜测。\n" +
        "⚠️ 仅支持查询，不能执行写操作：UPDATE/INSERT/DELETE/DDL 等会被 Yearning 查询通道过滤成空语句，导致 `Error 1065: Query was empty`，且不会真正执行。写操作（DML/DDL）请用 check_sql_order 和 submit_sql_order 走 Yearning SQL 审核工单流程。\n" +
        "建议自行加 LIMIT。返回为结果行数组（JSON）；多结果集时返回数组的数组。",
      inputSchema: {
        source_id: z.string().describe("数据源 source_id，必须来自 list_sources 或 yearning://sources"),
        schema: z.string().describe("库名/schema，通常来自 list_databases"),
        sql: z.string().describe("要执行的 SQL（建议只读，并带 LIMIT）"),
      },
    },
    async ({ source_id, schema, sql }) => {
      try {
        const results = await client.query(source_id, schema, sql);
        // 原样返回 JSON：单结果集 → 行数组；多结果集 → 行数组的数组。
        const payload = results.length === 1 ? results[0].rows : results.map((rs) => rs.rows);
        return textResult(JSON.stringify(payload, null, 2));
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "submit_query_order",
    {
      title: "提交查询工单",
      description:
        "显式提交 Yearning 查询工单。query 工具会在需要时自动提交查询工单；当 Yearning 开启查询审核、需要先申请查询权限时可直接调用本工具。",
      inputSchema: {
        source_id: z.string().describe("查询数据源 source_id，必须来自 list_sources"),
        reason: z.string().describe("申请查询原因"),
        export: z.boolean().default(false).describe("是否申请导出权限"),
      },
    },
    async ({ source_id, reason, export: exportEnabled }) => {
      try {
        const result = await client.submitQueryOrder(source_id, reason, exportEnabled);
        return textResult(JSON.stringify(result, null, 2));
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "list_query_orders",
    {
      title: "列出查询工单",
      description:
        "列出查询工单，默认返回待当前账号审批的查询工单。状态值沿用 Yearning：1 待审批，2 已同意，3 结束，4 已驳回，7 表示全部。",
      inputSchema: {
        status: z.number().int().optional().describe("查询工单状态；默认 1"),
        work_id: z.string().optional().describe("按工单号模糊过滤"),
        username: z.string().optional().describe("按申请人 username 过滤"),
        real_name: z.string().optional().describe("按申请人姓名过滤"),
        current: z.number().int().positive().default(1).describe("页码"),
        page_size: z.number().int().positive().max(100).default(20).describe("每页数量"),
      },
    },
    async ({ status, work_id, username, real_name, current, page_size }) => {
      try {
        const result = await client.listQueryOrders({ status, work_id, username, real_name }, current, page_size);
        return textResult(JSON.stringify(result, null, 2));
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "review_query_order",
    {
      title: "审批查询工单",
      description: "同意或驳回 Yearning 查询工单。只改变查询工单审批状态，不执行 SQL。",
      inputSchema: {
        work_id: z.string().describe("查询工单号"),
        action: z.enum(["agreed", "reject"]).describe("agreed=同意，reject=驳回"),
      },
    },
    async ({ work_id, action }) => {
      try {
        const result = await client.reviewQueryOrder({ work_id, action });
        return textResult(JSON.stringify(result, null, 2));
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // ---- Prompts ----

  server.registerPrompt(
    "query_workflow",
    {
      title: "Yearning 查询流程",
      description: "说明如何从数据源发现开始，经库表浏览后安全执行只读查询。",
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "使用 yearning-mcp 查询时请按这个顺序：\n" +
              "1. 如果用户没有给出明确的 source_id，先调用 list_sources 或读取 yearning://sources。\n" +
              "2. 根据返回的 source_id / source / idc 选择数据源；source_id 不能用库名、数据源中文名或 IDC 代替，也不要猜测。\n" +
              "3. 调用 list_databases({ source_id }) 获取 schema。\n" +
              "4. 需要看表时调用 list_tables({ source_id, schema })。\n" +
              "5. 调用 query({ source_id, schema, sql }) 执行 SELECT/SHOW/DESC/EXPLAIN 等只读 SQL，并尽量加 LIMIT。\n" +
              "6. 不要通过 query 执行 INSERT/UPDATE/DELETE/DDL；写操作应通过 list_order_sources、check_sql_order、submit_sql_order 提交 Yearning SQL 审核工单。",
          },
        },
      ],
    })
  );

  // ---- Resources（只读浏览）----

  server.registerResource(
    "sources",
    "yearning://sources",
    {
      title: "数据源列表",
      description:
        "当前用户可查询的全部数据源（JSON）。如果不知道 source_id，读取本资源或调用 list_sources；后续查询必须使用返回的 source_id。",
      mimeType: "application/json",
    },
    async (uri) => {
      const sources = await client.listSources();
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(sources, null, 2) }] };
    }
  );

  server.registerResource(
    "databases",
    new ResourceTemplate("yearning://{sourceId}/databases", { list: undefined }),
    {
      title: "库列表",
      description: "某数据源下的库列表（JSON）。sourceId 必须来自 list_sources 或 yearning://sources。",
      mimeType: "application/json",
    },
    async (uri, { sourceId }) => {
      const dbs = await client.listSchemas(String(sourceId));
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(dbs, null, 2) }] };
    }
  );

  server.registerResource(
    "tables",
    new ResourceTemplate("yearning://{sourceId}/{schema}/tables", { list: undefined }),
    {
      title: "表列表",
      description: "某数据源、某库下的表列表（JSON）。sourceId 必须来自 list_sources 或 yearning://sources。",
      mimeType: "application/json",
    },
    async (uri, { sourceId, schema }) => {
      const tables = await client.listTables(String(sourceId), String(schema));
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(tables, null, 2) }] };
    }
  );

  return server;
}

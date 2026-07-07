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
    { name: "yearning-mcp", version: "0.1.0" },
    {
      instructions:
        "Yearning 查询必须使用 source_id。source_id 不是库名，也不是数据源中文名；如果用户没有明确给出 source_id，必须先调用 list_sources 或读取 yearning://sources 获取可用数据源，再从返回的 source_id / source / idc 中选择。拿到 source_id 后再调用 list_databases，拿到 schema 后再调用 list_tables 或 query。不要猜测或编造 source_id。",
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
    "query",
    {
      title: "执行 SQL 查询",
      description:
        "通过 Yearning 执行一条【只读查询】SQL（SELECT/SHOW/DESC/EXPLAIN 等 DQL），返回 JSON。会经过 Yearning 的 SQL 审核与字段脱敏。\n" +
        "调用前必须已经知道 source_id 和 schema：source_id 来自 list_sources 或 yearning://sources；schema 来自 list_databases 或用户明确指定。如果不知道 source_id，先调用 list_sources，不要猜测。\n" +
        "⚠️ 仅支持查询，不能执行写操作：UPDATE/INSERT/DELETE/DDL 等会被 Yearning 查询通道过滤成空语句，导致 `Error 1065: Query was empty`，且不会真正执行。写操作（DML/DDL）请走 Yearning 网页端的 SQL 审核工单流程。\n" +
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
              "6. 不要通过 query 执行 INSERT/UPDATE/DELETE/DDL；写操作应走 Yearning 网页端审核工单。",
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

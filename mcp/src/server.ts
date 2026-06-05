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
  const server = new McpServer({ name: "yearning-mcp", version: "0.1.0" });

  // ---- Tools ----

  server.registerTool(
    "list_sources",
    {
      title: "列出数据源",
      description: "列出当前用户在 Yearning 中有查询权限的数据源，返回 source_id / source / idc。",
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
      description: "列出指定数据源下的数据库（schema）。",
      inputSchema: { source_id: z.string().describe("数据源 source_id（来自 list_sources）") },
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
      description: "列出指定数据源、指定库下的表。",
      inputSchema: {
        source_id: z.string().describe("数据源 source_id"),
        schema: z.string().describe("库名"),
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
        "通过 Yearning 执行一条查询型 SQL，返回 JSON。会经过 Yearning 的 SQL 审核与字段脱敏。建议只执行 SELECT 等只读语句，并自行加 LIMIT。返回为结果行数组（JSON）；多结果集时返回数组的数组。",
      inputSchema: {
        source_id: z.string().describe("数据源 source_id"),
        schema: z.string().describe("库名"),
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

  // ---- Resources（只读浏览）----

  server.registerResource(
    "sources",
    "yearning://sources",
    {
      title: "数据源列表",
      description: "当前用户可查询的全部数据源（JSON）。",
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
      description: "某数据源下的库列表（JSON）。",
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
      description: "某数据源、某库下的表列表（JSON）。",
      mimeType: "application/json",
    },
    async (uri, { sourceId, schema }) => {
      const tables = await client.listTables(String(sourceId), String(schema));
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(tables, null, 2) }] };
    }
  );

  return server;
}

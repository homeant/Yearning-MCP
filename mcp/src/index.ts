#!/usr/bin/env node
// yearning-mcp 入口：读取环境配置 → 准备 Yearning 客户端 → 以 stdio 启动 MCP server。
//
// 重要：stdio 传输用 stdout 传 JSON-RPC，任何写到 stdout 的日志都会破坏协议，
// 因此所有日志一律走 stderr。

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { YearningClient } from "./client.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const cfg = loadConfig();

  // 优先用凭据（用户名/密码/LDAP）以支持过期/401 自动重登；否则退化为仅用 token。
  const creds =
    cfg.username && cfg.password
      ? { username: cfg.username, password: cfg.password, ldap: cfg.ldap }
      : undefined;

  if (!cfg.token && !creds) {
    throw new Error(
      "缺少凭据：请设置 YEARNING_TOKEN，或同时设置 YEARNING_USERNAME 与 YEARNING_PASSWORD"
    );
  }

  // token 持有在内存中（YearningClient 实例），不落盘；过期或 401 时自动用凭据重登刷新。
  const client = new YearningClient(cfg.endpoint, cfg.token, creds);

  const server = buildServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `yearning-mcp 已启动（stdio），后端：${cfg.endpoint}，鉴权：${creds ? `账号 ${creds.username}${creds.ldap ? "(LDAP)" : ""} 自动登录` : "固定 token"}`
  );
}

main().catch((err: unknown) => {
  console.error("yearning-mcp 启动失败：", (err as Error)?.message ?? err);
  process.exit(1);
});

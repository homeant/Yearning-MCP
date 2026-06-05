// 通过环境变量加载配置（MCP 服务的标准做法，便于在 Claude Desktop/Code 的 mcp 配置里注入）。

export interface Config {
  endpoint: string;
  token?: string;
  username?: string;
  password?: string;
  ldap: boolean;
}

function truthy(v: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(v ?? "");
}

export function loadConfig(): Config {
  const endpoint = process.env.YEARNING_ENDPOINT;
  if (!endpoint) {
    throw new Error(
      "缺少 YEARNING_ENDPOINT 环境变量（Yearning 服务地址，如 http://127.0.0.1:8000）"
    );
  }
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    token: process.env.YEARNING_TOKEN || undefined,
    username: process.env.YEARNING_USERNAME || undefined,
    password: process.env.YEARNING_PASSWORD || undefined,
    ldap: truthy(process.env.YEARNING_LDAP),
  };
}

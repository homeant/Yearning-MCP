// Yearning HTTP/WebSocket API 的 TypeScript 客户端。
// 不直连数据库，全部经 Yearning 接口。接口契约对齐 Yearning v3.1.9。

import WebSocket from "ws";
import { encode, decode } from "@msgpack/msgpack";

const CODE_SUCCESS = 1200;

export interface Source {
  source: string;
  idc: string;
  source_id: string;
}

export type SqlOrderType = 0 | 1;
export type SqlOrderSourceKind = "ddl" | "dml" | "all";
export type OrderReviewAction = "agree" | "reject";
export type QueryOrderReviewAction = "agreed" | "reject";

export interface TreeNode {
  title: string;
  key: string;
  meta: string;
  isLeaf: boolean;
}

export interface ResultSet {
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface OperationResult {
  code: number;
  text: string;
  payload: unknown;
}

export interface SqlCheckRecord {
  sql?: string;
  SQL?: string;
  error?: string;
  Error?: string;
  [key: string]: unknown;
}

export interface SqlOrderInput {
  source_id: string;
  data_base: string;
  table: string;
  sql: string;
  text: string;
  type: SqlOrderType;
  backup?: 0 | 1;
  delay?: string;
  execute_time?: string;
  relevant?: string[];
  source?: string;
  idc?: string;
  file?: string;
}

export interface SqlOrderReviewInput {
  work_id: string;
  action: OrderReviewAction;
  source_id?: string;
  current_step?: number;
  reason?: string;
}

export interface QueryOrderReviewInput {
  work_id: string;
  action: QueryOrderReviewAction;
}

export interface OrderListFilters {
  status?: number;
  type?: number;
  text?: string;
  username?: string;
  real_name?: string;
  work_id?: string;
  picker?: [string, string];
}

export interface OrderListResult<T = unknown> {
  data: T[];
  page: number;
}

interface Envelope<T = unknown> {
  payload: T;
  code: number;
  text: string;
}

// WebSocket 查询返回（msgpack），字段名对齐后端 personal.queryResults。
interface WsResult {
  export?: boolean;
  error?: string;
  results?: Array<{
    field?: Array<Record<string, unknown>>;
    data?: Array<Record<string, unknown>> | null;
  }> | null;
  query_time?: number;
  status?: boolean;
  heartbeat?: string;
  is_only?: boolean;
}

/** 自动登录所需的凭据。 */
export interface Credentials {
  username: string;
  password: string;
  ldap: boolean;
}

export class YearningClient {
  private token: string;
  private creds?: Credentials;

  /**
   * 已建过查询工单的 source（进程内缓存）。
   * 后端校验工单只按 username+status=2、不绑 source（见 Yearning personal/query.go），
   * 工单可复用且默认配置下不过期，故同一 source 只在首次查询时建一张，后续复用，
   * 仅当后端报“无有效工单”（过期/失效）时再补建。
   */
  private orderedSources = new Set<string>();

  /**
   * @param endpoint Yearning 地址
   * @param token    已有 JWT，可为空
   * @param creds    用户名/密码凭据，提供后将按需自动登录、过期/401 自动重登
   */
  constructor(private endpoint: string, token = "", creds?: Credentials) {
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.token = token;
    this.creds = creds;
  }

  get hasToken(): boolean {
    return this.token !== "";
  }

  get canLogin(): boolean {
    return !!this.creds;
  }

  /** 本地账号或 LDAP 登录，成功后保存 token。 */
  async login(username: string, password: string, ldap = false): Promise<void> {
    const env = await this.http("POST", ldap ? "/ldap" : "/login", { username, password }, false);
    if (env.code !== CODE_SUCCESS) {
      throw new Error(`登录失败：${env.text || "用户名或密码错误"}`);
    }
    const p = env.payload as { token?: string };
    if (!p?.token) throw new Error("登录响应缺少 token");
    this.token = p.token;
  }

  /** 解析当前 JWT 的 exp（Unix 秒）；无法解析返回 null。 */
  private tokenExp(): number | null {
    const parts = this.token.split(".");
    if (parts.length !== 3) return null;
    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      return typeof payload.exp === "number" ? payload.exp : null;
    } catch {
      return null;
    }
  }

  /** token 存在且未临近过期（预留 30s）。无法解析 exp 时不主动判失效。 */
  private tokenValid(): boolean {
    if (!this.token) return false;
    const exp = this.tokenExp();
    if (exp === null) return true;
    return Date.now() / 1000 < exp - 30;
  }

  /** 受权请求前保证有可用 token：过期/缺失且有凭据则登录。 */
  private async ensureLogin(): Promise<void> {
    if (this.tokenValid()) return;
    if (!this.creds) {
      if (this.token) return; // 有 token 无凭据，先用着，由服务端裁决
      throw new Error("未配置凭据：请设置 YEARNING_TOKEN，或 YEARNING_USERNAME/PASSWORD");
    }
    await this.login(this.creds.username, this.creds.password, this.creds.ldap);
  }

  /** 当前用户有查询权限的数据源。 */
  async listSources(): Promise<Source[]> {
    const env = await this.http("GET", "/api/v2/fetch/source?tp=query", undefined, true);
    this.requireSuccess(env, "获取数据源");
    // 后端此处仅 Select 了 source/id_c/source_id，其余字段为空噪音，精简掉。
    return ((env.payload as Source[]) ?? []).map((s) => ({
      source_id: s.source_id,
      source: s.source,
      idc: s.idc,
    }));
  }

  /** 指定数据源下的库列表。 */
  async listSchemas(sourceId: string): Promise<string[]> {
    const q = new URLSearchParams({ source_id: sourceId });
    const env = await this.http("GET", `/api/v2/query/schema?${q}`, undefined, true);
    this.requireSuccess(env, "获取库列表");
    return ((env.payload as TreeNode[]) ?? []).map((n) => n.title);
  }

  /** 指定数据源、指定库下的表列表。 */
  async listTables(sourceId: string, schema: string): Promise<string[]> {
    const q = new URLSearchParams({ source_id: sourceId, schema });
    const env = await this.http("GET", `/api/v2/query/tables?${q}`, undefined, true);
    this.requireSuccess(env, "获取表列表");
    const wrap = (env.payload as { table?: TreeNode[] }) ?? {};
    return (wrap.table ?? []).map((n) => n.title);
  }

  /** 当前用户可提交 SQL 审核工单的数据源。 */
  async listOrderSources(kind: SqlOrderSourceKind = "all"): Promise<Source[]> {
    const env = await this.http("GET", `/api/v2/fetch/source?tp=${encodeURIComponent(kind)}`, undefined, true);
    this.requireSuccess(env, "获取工单数据源");
    return ((env.payload as Source[]) ?? []).map((s) => ({
      source_id: s.source_id,
      source: s.source,
      idc: s.idc,
    }));
  }

  /** 调用 Yearning Engine.Check 预检查待提交 SQL。kind: 0=DDL, 1=DML。 */
  async checkSqlOrder(sourceId: string, schema: string, sql: string, kind: SqlOrderType, workId = ""): Promise<SqlCheckRecord[]> {
    const env = await this.http(
      "PUT",
      "/api/v2/fetch/test",
      { source_id: sourceId, data_base: schema, sql, kind, work_id: workId },
      true
    );
    this.requireSuccess(env, "SQL 检测");
    return (env.payload as SqlCheckRecord[]) ?? [];
  }

  /** 提交 DDL/DML SQL 审核工单。type: 0=DDL, 1=DML。 */
  async submitSqlOrder(input: SqlOrderInput): Promise<OperationResult> {
    const env = await this.http(
      "POST",
      "/api/v2/common/post",
      {
        source_id: input.source_id,
        data_base: input.data_base,
        table: input.table,
        sql: input.sql,
        text: input.text,
        type: input.type,
        backup: input.backup ?? 0,
        delay: input.delay ?? "none",
        execute_time: input.execute_time ?? "",
        relevant: input.relevant ?? [],
        source: input.source ?? "",
        idc: input.idc ?? "",
        file: input.file ?? "",
      },
      true
    );
    this.requireSuccess(env, "提交 SQL 工单");
    return this.operationResult(env);
  }

  /**
   * 审批 SQL 审核工单。
   * 注意：最后一个审批节点同意后，Yearning 会通过审核引擎执行工单 SQL。
   */
  async reviewSqlOrder(input: SqlOrderReviewInput): Promise<OperationResult> {
    if (input.action === "agree" && !input.source_id) {
      throw new Error("审批 SQL 工单需要 source_id，用于匹配 Yearning 审批流程");
    }
    const env = await this.http(
      "POST",
      "/api/v2/audit/order/state",
      {
        tp: input.action,
        work_id: input.work_id,
        source_id: input.source_id ?? "",
        flag: input.current_step ?? 1,
        text: input.reason ?? "",
      },
      true
    );
    this.requireSuccess(env, input.action === "agree" ? "审批 SQL 工单" : "驳回 SQL 工单");
    return this.operationResult(env);
  }

  /** 显式提交查询工单；query() 仍会按需自动创建查询工单。 */
  async submitQueryOrder(sourceId: string, reason: string, exportEnabled = false): Promise<OperationResult> {
    const env = await this.http("POST", "/api/v2/query/post", { source_id: sourceId, export: exportEnabled ? 1 : 0, text: reason }, true);
    this.requireSuccess(env, "提交查询工单");
    return this.operationResult(env);
  }

  /** 审批或驳回查询工单。 */
  async reviewQueryOrder(input: QueryOrderReviewInput): Promise<OperationResult> {
    const env = await this.http("POST", `/api/v2/audit/query/${input.action}`, { work_id: input.work_id }, true);
    this.requireSuccess(env, input.action === "agreed" ? "审批查询工单" : "驳回查询工单");
    return this.operationResult(env);
  }

  /** 列出 SQL 审核工单；scope=assigned 为待我审批视角，scope=mine 为我提交的工单。 */
  async listSqlOrders(
    scope: "assigned" | "mine" = "assigned",
    filters: OrderListFilters = {},
    current = 1,
    pageSize = 20
  ): Promise<OrderListResult> {
    const input = {
      current,
      pageSize,
      expr: {
        picker: filters.picker ?? [],
        text: filters.text ?? "",
        work_id: filters.work_id ?? "",
        type: filters.type ?? 2,
        status: filters.status ?? (scope === "assigned" ? 2 : 8),
        username: filters.username ?? "",
        real_name: filters.real_name ?? "",
      },
    };
    const env = await this.wsJson<Envelope<{ data?: unknown[]; page?: number }>>(
      scope === "assigned" ? "/api/v2/audit/order/list" : "/api/v2/common/list",
      {},
      input,
      "获取 SQL 工单列表"
    );
    this.requireSuccess(env, "获取 SQL 工单列表");
    return { data: env.payload?.data ?? [], page: env.payload?.page ?? 0 };
  }

  /** 列出查询工单；默认返回待当前账号审批的查询工单。 */
  async listQueryOrders(filters: OrderListFilters = {}, current = 1, pageSize = 20): Promise<OrderListResult> {
    const input = {
      current,
      pageSize,
      expr: {
        picker: filters.picker ?? [],
        work_id: filters.work_id ?? "",
        status: filters.status ?? 1,
        username: filters.username ?? "",
        real_name: filters.real_name ?? "",
      },
    };
    const env = await this.wsJson<Envelope<{ data?: unknown[]; page?: number }>>(
      "/api/v2/audit/query/list",
      {},
      input,
      "获取查询工单列表"
    );
    this.requireSuccess(env, "获取查询工单列表");
    return { data: env.payload?.data ?? [], page: env.payload?.page ?? 0 };
  }

  /**
   * 创建查询工单。查询审核关闭时后端会即时生成 status=2 工单并返回空 body；
   * 开启审核时生成待审工单，需管理员批准。
   */
  async ensureQueryOrder(sourceId: string, reason = "yearning-mcp query"): Promise<void> {
    await this.http("POST", "/api/v2/query/post", { source_id: sourceId, export: 0, text: reason }, true);
  }

  /** 执行一条 SQL 查询，返回（可能多个）结果集。 */
  async query(sourceId: string, schema: string, sql: string): Promise<ResultSet[]> {
    await this.ensureLogin();

    // 同 source 复用工单：首次查询该 source 时建一张，后续直接复用。
    if (!this.orderedSources.has(sourceId)) {
      await this.ensureQueryOrder(sourceId);
      this.orderedSources.add(sourceId);
    }

    let res = await this.runQuery(sourceId, schema, sql);

    // status=true 表示后端没找到有效的 status=2 工单（被作废/过期，或开启审核时尚未批准）。
    // 补建一张工单后重试一次；若仍为 true，则多半是开启了查询审核、需人工批准。
    if (res.status) {
      await this.ensureQueryOrder(sourceId);
      this.orderedSources.add(sourceId);
      res = await this.runQuery(sourceId, schema, sql);
      if (res.status) {
        throw new Error(
          "无有效查询工单：Yearning 可能开启了查询审核，请到网页端提交并等待管理员批准查询工单后重试"
        );
      }
    }

    if (res.error) throw new Error(`查询出错：${res.error}`);
    return (res.results ?? [])
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => ({
        columns: (r.field ?? []).map((f) => String(f.title)),
        rows: (r.data ?? []) as Record<string, unknown>[],
      }));
  }

  /** 执行一次 WS 查询，封装 WebSocket 握手鉴权失败（401/403）后的重登重试。 */
  private async runQuery(sourceId: string, schema: string, sql: string): Promise<WsResult> {
    try {
      return await this.wsQuery(sourceId, schema, sql);
    } catch (e) {
      // WebSocket 握手鉴权失败（ws 报 "Unexpected server response: 401/403"）时重登重试一次。
      if (this.creds && /\b(401|403)\b/.test((e as Error).message)) {
        await this.login(this.creds.username, this.creds.password, this.creds.ldap);
        return await this.wsQuery(sourceId, schema, sql);
      }
      throw e;
    }
  }

  // ---- 内部实现 ----

  /** 发送一次请求，返回状态码与原始文本（不重试/不解析）。 */
  private async doFetch(
    method: string,
    path: string,
    body: unknown,
    auth: boolean
  ): Promise<{ status: number; text: string }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (auth) {
      // yee JWT 中间件默认 AuthScheme=Bearer。
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    let resp: Response;
    try {
      resp = await fetch(this.endpoint + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error(`请求 ${path} 失败：${(e as Error).message}`);
    }
    return { status: resp.status, text: await resp.text() };
  }

  private async http(
    method: string,
    path: string,
    body: unknown,
    auth: boolean
  ): Promise<Envelope> {
    if (auth) await this.ensureLogin();
    let { status, text } = await this.doFetch(method, path, body, auth);
    if (status === 401 && auth && this.creds) {
      // token 过期或失效，重新登录后重试一次。
      await this.login(this.creds.username, this.creds.password, this.creds.ldap);
      ({ status, text } = await this.doFetch(method, path, body, auth));
    }
    if (status === 401 || status === 403) {
      throw new Error(`鉴权失败（HTTP ${status}）：token 可能已过期或无权限，请检查凭据`);
    }
    if (status < 200 || status >= 300) {
      throw new Error(`请求失败（HTTP ${status}）：${text.slice(0, 200) || "空响应"}`);
    }
    // 部分接口成功时返回空 body（如关闭审核时的 ReferQueryOrder），视作成功的空信封。
    if (text.trim() === "") {
      return { payload: null, code: CODE_SUCCESS, text: "" };
    }
    try {
      return JSON.parse(text) as Envelope;
    } catch {
      throw new Error(`解析响应失败（HTTP ${status}）：${text.slice(0, 200)}`);
    }
  }

  private requireSuccess(env: Envelope, action: string): void {
    if (env.code === CODE_SUCCESS) return;
    const detail = env.text || (env.payload !== undefined ? JSON.stringify(env.payload) : "未知错误");
    throw new Error(`${action}失败：${detail}`);
  }

  private operationResult(env: Envelope): OperationResult {
    return { code: env.code, text: env.text ?? "", payload: env.payload ?? null };
  }

  private wsURL(sourceId: string): string {
    const u = new URL(this.endpoint);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = u.pathname.replace(/\/+$/, "") + "/api/v2/query/results";
    u.search = new URLSearchParams({ source_id: sourceId }).toString();
    return u.toString();
  }

  private wsURLFor(path: string, query: Record<string, string> = {}): string {
    const u = new URL(this.endpoint);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = u.pathname.replace(/\/+$/, "") + path;
    u.search = new URLSearchParams(query).toString();
    return u.toString();
  }

  private async wsJson<T>(path: string, query: Record<string, string>, input: unknown, action: string): Promise<T> {
    await this.ensureLogin();
    const u = new URL(this.endpoint);
    const origin = `${u.protocol}//${u.host}`;
    return new Promise<T>((resolve, reject) => {
      const ws = new WebSocket(this.wsURLFor(path, query), this.token, { origin });
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        fn();
      };
      const timer = setTimeout(() => {
        finish(() => reject(new Error(`${action}超时（60s）`)));
      }, 60_000);

      ws.on("open", () => {
        ws.send(JSON.stringify(input));
      });
      ws.on("message", (data: WebSocket.RawData) => {
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Buffer.from(new Uint8Array(data as ArrayBuffer)).toString("utf8");
        try {
          finish(() => resolve(JSON.parse(text) as T));
        } catch (e) {
          finish(() => reject(new Error(`${action}响应解析失败：${(e as Error).message}`)));
        }
      });
      ws.on("error", (err: Error) => {
        finish(() => reject(new Error(`WebSocket 错误：${err.message}`)));
      });
      ws.on("close", (code: number, reason: Buffer) => {
        const r = reason?.toString().trim();
        finish(() => reject(new Error(`WebSocket 连接被关闭（code=${code}${r ? `，${r}` : ""}），未收到结果`)));
      });
      ws.on("unexpected-response", (_req, res) => {
        const status = res.statusCode;
        res.resume();
        finish(() => reject(new Error(`WebSocket 握手失败：HTTP ${status}`)));
      });
    });
  }

  private wsQuery(sourceId: string, schema: string, sql: string): Promise<WsResult> {
    // 部分反向代理/WAF 会校验 Origin，缺失则拒绝 WebSocket 升级（返回 403）。
    // 浏览器前端天然带 Origin，这里显式补上，取后端同源。
    const u = new URL(this.endpoint);
    const origin = `${u.protocol}//${u.host}`;
    return new Promise<WsResult>((resolve, reject) => {
      // 鉴权通过 Sec-WebSocket-Protocol 头携带原始 token（与浏览器前端一致）。
      const ws = new WebSocket(this.wsURL(sourceId), this.token, { origin });
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        fn();
      };
      const timer = setTimeout(() => {
        finish(() => reject(new Error("查询超时（60s）")));
      }, 60_000);

      ws.on("open", () => {
        const payload = encode({ type: 0, sql, schema, source_id: sourceId });
        ws.send(payload);
      });
      ws.on("message", (data: WebSocket.RawData) => {
        let msg: WsResult;
        try {
          msg = decode(data as Uint8Array) as WsResult;
        } catch (e) {
          finish(() => reject(new Error(`解析查询结果失败：${(e as Error).message}`)));
          return;
        }
        if (msg.heartbeat) return; // 跳过心跳帧
        finish(() => resolve(msg));
      });
      ws.on("error", (err: Error) => {
        finish(() => reject(new Error(`WebSocket 错误：${err.message}`)));
      });
      // 服务端在返回结果前就关闭连接（后端异常 / 被代理或网关切断 / 只发心跳后断开）：
      // 立即失败，不再傻等 60s 超时——这正是“查询卡住、MCP 随后掉线”的根因。
      ws.on("close", (code: number, reason: Buffer) => {
        const r = reason?.toString().trim();
        finish(() =>
          reject(new Error(`WebSocket 连接被关闭（code=${code}${r ? `，${r}` : ""}），未收到查询结果`))
        );
      });
      // 握手返回非 101（鉴权 401/403、网关 5xx 等）。注册本监听后 ws 不再自动抛 error，
      // 需自行 reject；消息带上状态码，使上层 runQuery 的 401/403 重登重试仍能命中。
      ws.on("unexpected-response", (_req, res) => {
        const status = res.statusCode;
        res.resume(); // 排空响应流，避免 socket 挂起
        finish(() => reject(new Error(`WebSocket 握手失败：HTTP ${status}`)));
      });
    });
  }
}

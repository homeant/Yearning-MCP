// 端到端测试：用假 Yearning 服务端验证 TS 客户端的 HTTP + WebSocket(msgpack) 往返。
// 运行：npm test（会先 build 出 dist/，再用 node:test 跑本文件）。

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import { encode, decode } from "@msgpack/msgpack";
import { YearningClient } from "../dist/client.js";

function startFakeYearning() {
  let wsTokenSeen = null;
  let wsRefSeen = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (obj, status = 200) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(obj));
      };
      if (url.pathname === "/login") {
        json({ code: 1200, payload: { token: "tok-123", real_name: "管理员", user: "admin" }, text: "" });
      } else if (url.pathname === "/api/v2/fetch/source") {
        assert.equal(url.searchParams.get("tp"), "query", "应通过 ?tp=query 传参");
        assert.equal(req.headers["authorization"], "Bearer tok-123");
        json({ code: 1200, payload: [{ source: "主库", idc: "bj", source_id: "s1" }], text: "" });
      } else if (url.pathname === "/api/v2/query/schema") {
        json({ code: 1200, payload: [{ title: "testdb", key: "testdb", meta: "Schema", isLeaf: false }], text: "" });
      } else if (url.pathname === "/api/v2/query/tables") {
        json({ code: 1200, payload: { table: [{ title: "account", key: "`testdb`.`account`", meta: "Table", isLeaf: true }] }, text: "" });
      } else if (url.pathname === "/api/v2/query/post") {
        res.statusCode = 200;
        res.end(); // 关闭审核时的空 body
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
  });

  let wsOriginSeen = null;
  const wss = new WebSocketServer({ server, path: "/api/v2/query/results" });
  wss.on("connection", (ws, req) => {
    wsTokenSeen = req.headers["sec-websocket-protocol"] || null;
    wsOriginSeen = req.headers["origin"] || null;
    ws.on("message", (data) => {
      wsRefSeen = decode(data);
      const out = encode({
        query_time: 5,
        results: [{ field: [{ title: "n" }], data: [{ n: "1" }] }],
      });
      ws.send(out);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = server.address().port;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        token: () => wsTokenSeen,
        origin: () => wsOriginSeen,
        ref: () => wsRefSeen,
      });
    });
  });
}

function makeJWT(exp) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64({ exp })}.sig`;
}

// 一个只关心鉴权的最小服务端：/login 计数并发 fresh token；受保护接口要求 Bearer fresh。
function startAuthServer() {
  let loginCount = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const json = (o, s = 200) => {
        res.statusCode = s;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(o));
      };
      if (url.pathname === "/login") {
        loginCount++;
        json({ code: 1200, payload: { token: "fresh", user: "admin" }, text: "" });
      } else if (url.pathname === "/api/v2/fetch/source") {
        if (req.headers["authorization"] !== "Bearer fresh") {
          res.statusCode = 401;
          res.end();
          return;
        }
        json({ code: 1200, payload: [{ source_id: "s1", source: "x", idc: "y" }], text: "" });
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, count: () => loginCount }))
  );
}

test("401 自动重登重试", async () => {
  const a = await startAuthServer();
  try {
    const c = new YearningClient(a.url, "stale-token", { username: "admin", password: "pw", ldap: false });
    const s = await c.listSources();
    assert.equal(s.length, 1);
    assert.equal(s[0].source_id, "s1");
    assert.equal(a.count(), 1, "应触发一次自动登录");
  } finally {
    a.server.close();
  }
});

test("过期 token 主动重登（不等 401）", async () => {
  const a = await startAuthServer();
  try {
    const expired = makeJWT(Math.floor(Date.now() / 1000) - 3600);
    const c = new YearningClient(a.url, expired, { username: "admin", password: "pw", ldap: false });
    await c.listSources();
    assert.equal(a.count(), 1, "应在发请求前就主动登录一次");
  } finally {
    a.server.close();
  }
});

test("login + listSources（query 参数 + Bearer）", async () => {
  const fake = await startFakeYearning();
  try {
    const c = new YearningClient(fake.url);
    await c.login("admin", "pass");
    assert.equal(c.hasToken, true);
    const sources = await c.listSources();
    assert.equal(sources.length, 1);
    assert.equal(sources[0].source_id, "s1");
  } finally {
    fake.server.close();
  }
});

test("listSchemas / listTables", async () => {
  const fake = await startFakeYearning();
  try {
    const c = new YearningClient(fake.url, "tok-123");
    assert.deepEqual(await c.listSchemas("s1"), ["testdb"]);
    assert.deepEqual(await c.listTables("s1", "testdb"), ["account"]);
  } finally {
    fake.server.close();
  }
});

test("query：WebSocket msgpack 往返 + token 经 Sec-WebSocket-Protocol", async () => {
  const fake = await startFakeYearning();
  try {
    const c = new YearningClient(fake.url, "tok-123");
    const results = await c.query("s1", "testdb", "SELECT 1 AS n");
    assert.equal(fake.token(), "tok-123", "服务端应通过 Sec-WebSocket-Protocol 收到 token");
    assert.equal(fake.origin(), fake.url, "应携带 Origin（避免反代/WAF 403）");
    assert.deepEqual(fake.ref(), { type: 0, sql: "SELECT 1 AS n", schema: "testdb", source_id: "s1" });
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].columns, ["n"]);
    assert.deepEqual(results[0].rows, [{ n: "1" }]);
  } finally {
    fake.server.close();
  }
});

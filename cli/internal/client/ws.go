package client

import (
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/vmihailenco/msgpack/v5"
	"golang.org/x/net/websocket"
)

// wsURL 把 HTTP(S) 的 Endpoint 转换为查询用的 WebSocket 地址。
func (c *Client) wsURL(sourceID string) (string, string, error) {
	u, err := url.Parse(c.Endpoint)
	if err != nil {
		return "", "", err
	}
	origin := u.String()
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	default:
		u.Scheme = "ws"
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/api/v2/query/results"
	u.RawQuery = url.Values{"source_id": {sourceID}}.Encode()
	return u.String(), origin, nil
}

// Query 通过 WebSocket 执行一条 SQL 并返回结果。
//   - sourceID / schema 指定数据源与库
//   - 鉴权通过 Sec-WebSocket-Protocol 头携带原始 token（与浏览器前端一致）
//   - 请求/响应均为 msgpack 二进制帧
//
// 受权策略：先 ensureLogin 保证 token 有效；若 WebSocket 握手因鉴权失败（bad status，
// 即 401/403），则用凭据重登并重试一次。
//
// 注意：后端要求当前用户存在一张 status=2 的查询工单，否则返回 Status=true。
// 调用方应先调用 EnsureQueryOrder。
func (c *Client) Query(sourceID, schema, sql string) (*QueryResults, error) {
	if err := c.ensureLogin(); err != nil {
		return nil, err
	}
	res, err := c.queryOnce(sourceID, schema, sql)
	if err != nil && isWSAuthErr(err) && c.creds != nil {
		// token 可能在服务端被提前失效，重登重试一次。
		if lErr := c.doLogin(); lErr != nil {
			return nil, fmt.Errorf("自动重新登录失败：%w", lErr)
		}
		res, err = c.queryOnce(sourceID, schema, sql)
	}
	return res, err
}

// isWSAuthErr 判断 WebSocket 握手错误是否为鉴权类（x/net/websocket 对非 101 响应返回 "bad status"）。
func isWSAuthErr(err error) bool {
	s := err.Error()
	return strings.Contains(s, "bad status") || strings.Contains(s, "401") || strings.Contains(s, "403")
}

// queryOnce 执行一次 WebSocket 查询（不含重登重试）。
func (c *Client) queryOnce(sourceID, schema, sql string) (*QueryResults, error) {
	wsAddr, origin, err := c.wsURL(sourceID)
	if err != nil {
		return nil, err
	}
	cfg, err := websocket.NewConfig(wsAddr, origin)
	if err != nil {
		return nil, err
	}
	// yee 在 WebSocket 场景下从 Sec-WebSocket-Protocol 头读取原始 token（无 Bearer 前缀）。
	cfg.Protocol = []string{c.Token}

	ws, err := websocket.DialConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("建立 WebSocket 连接失败：%w", err)
	}
	defer ws.Close()

	payload, err := msgpack.Marshal(queryRef{
		Type:     0,
		Sql:      sql,
		Schema:   schema,
		SourceId: sourceID,
	})
	if err != nil {
		return nil, err
	}
	if err := websocket.Message.Send(ws, payload); err != nil {
		return nil, fmt.Errorf("发送查询失败：%w", err)
	}

	// 读取响应，跳过心跳帧，直到拿到结果 / 错误 / 状态信号。
	_ = ws.SetReadDeadline(time.Now().Add(60 * time.Second))
	for {
		var b []byte
		if err := websocket.Message.Receive(ws, &b); err != nil {
			return nil, fmt.Errorf("接收查询结果失败：%w", err)
		}
		var res QueryResults
		if err := msgpack.Unmarshal(b, &res); err != nil {
			return nil, fmt.Errorf("解析查询结果失败：%w", err)
		}
		if res.HeartBeat != "" {
			continue
		}
		return &res, nil
	}
}

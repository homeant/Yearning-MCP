// Package client 是 Yearning HTTP/WebSocket API 的 Go 客户端。
// 它不直连数据库，全部通过 Yearning 暴露的接口完成登录、数据源/库/表查询与 SQL 执行。
//
// 鉴权策略：客户端持有用户名/密码（Credentials），按需登录换取 JWT。
// 每次受权请求前会按 JWT 的 exp 主动判断是否过期；若过期或服务端返回 401，
// 则自动用凭据重新登录并重试一次。新 token 通过 OnToken 回调交由上层持久化（CLI）或仅留内存（MCP）。
package client

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Credentials 是自动登录所需的凭据。
type Credentials struct {
	Username string
	Password string
	LDAP     bool
}

// Client 封装对单个 Yearning 服务的访问。
type Client struct {
	Endpoint string // 例如 http://127.0.0.1:8000，无尾部斜杠
	Token    string // 当前 JWT（登录后获得，可能为空）

	creds   *Credentials             // 自动登录凭据，可为 nil
	onToken func(token string, exp int64) // 刷新 token 后的回调（持久化），可为 nil
	http    *http.Client
}

// New 创建一个仅持 token 的客户端（无自动登录能力，主要用于测试与只读场景）。
func New(endpoint, token string) *Client {
	return &Client{
		Endpoint: strings.TrimRight(endpoint, "/"),
		Token:    token,
		http:     &http.Client{Timeout: 30 * time.Second},
	}
}

// NewWithAuth 创建带自动登录能力的客户端。
//   - token：已缓存的 JWT，可为空（为空或过期时将用 creds 登录）
//   - creds：用户名/密码凭据，可为 nil（则退化为仅用 token）
//   - onToken：每次成功登录后回调，便于上层持久化 token 与过期时间
func NewWithAuth(endpoint, token string, creds *Credentials, onToken func(token string, exp int64)) *Client {
	c := New(endpoint, token)
	c.creds = creds
	c.onToken = onToken
	return c
}

// ---- 鉴权与自动登录 ----

// tokenExp 解析当前 JWT 的 exp（Unix 秒）。无法解析时返回 ok=false。
func (c *Client) tokenExp() (int64, bool) {
	parts := strings.Split(c.Token, ".")
	if len(parts) != 3 {
		return 0, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return 0, false
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil || claims.Exp == 0 {
		return 0, false
	}
	return claims.Exp, true
}

// tokenValid 判断当前 token 是否存在且未临近过期（预留 30s 偏差）。
// 无法解析 exp 时不主动判失效，交由服务端决定。
func (c *Client) tokenValid() bool {
	if c.Token == "" {
		return false
	}
	exp, ok := c.tokenExp()
	if !ok {
		return true
	}
	return time.Now().Unix() < exp-30
}

// ensureLogin 在受权请求前保证有可用 token：过期/缺失且有凭据则登录。
func (c *Client) ensureLogin() error {
	if c.tokenValid() {
		return nil
	}
	if c.creds == nil {
		if c.Token != "" {
			return nil // 有 token 但无凭据可刷新，先用着，由服务端裁决
		}
		return fmt.Errorf("未配置凭据：请用 `yearning-cli config set --username <用户> --password <密码>` 设置")
	}
	return c.doLogin()
}

// doLogin 用凭据登录并通过 onToken 回传新 token。
func (c *Client) doLogin() error {
	path := "/login"
	if c.creds.LDAP {
		path = "/ldap"
	}
	if _, err := c.login(path, c.creds.Username, c.creds.Password); err != nil {
		return err
	}
	if c.onToken != nil {
		exp, _ := c.tokenExp()
		c.onToken(c.Token, exp)
	}
	return nil
}

// ---- 底层请求 ----

// doRequest 发送一次 HTTP 请求，返回状态码与原始响应体（不做重试/不解析信封）。
func (c *Client) doRequest(method, path string, body interface{}, auth bool) (int, []byte, error) {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.Endpoint+path, rdr)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if auth {
		// yee JWT 中间件默认 AuthScheme=Bearer，HTTP 请求需带前缀。
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("请求 %s 失败：%w", path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, raw, nil
}

// doJSON 发送受权/公开请求并解析统一响应信封。
// 受权请求会先 ensureLogin；若仍返回 401，则用凭据重登并重试一次。
func (c *Client) doJSON(method, path string, body interface{}, auth bool) (*Resp, error) {
	if auth {
		if err := c.ensureLogin(); err != nil {
			return nil, err
		}
	}
	status, raw, err := c.doRequest(method, path, body, auth)
	if err != nil {
		return nil, err
	}
	if status == http.StatusUnauthorized && auth && c.creds != nil {
		// token 过期或失效，重新登录后重试一次。
		if lErr := c.doLogin(); lErr != nil {
			return nil, fmt.Errorf("自动重新登录失败：%w", lErr)
		}
		status, raw, err = c.doRequest(method, path, body, auth)
		if err != nil {
			return nil, err
		}
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return nil, fmt.Errorf("鉴权失败（HTTP %d）：token 可能已过期或无权限，请检查凭据", status)
	}
	// 部分接口成功时返回空 body（如关闭查询审核时的 ReferQueryOrder 直接 return），视作成功的空信封。
	if len(bytes.TrimSpace(raw)) == 0 {
		return &Resp{Code: CodeSuccess}, nil
	}
	var r Resp
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("解析响应失败（HTTP %d）：%s", status, strings.TrimSpace(string(raw)))
	}
	return &r, nil
}

// Login 通过本地账号（用户名密码）登录。
func (c *Client) Login(username, password string) (*LoginPayload, error) {
	return c.login("/login", username, password)
}

// LoginLDAP 通过 LDAP 登录。请求/响应与本地登录一致，仅接口路径不同。
func (c *Client) LoginLDAP(username, password string) (*LoginPayload, error) {
	return c.login("/ldap", username, password)
}

// login 是登录的共用实现，成功后写入 c.Token 并返回 payload。
func (c *Client) login(path, username, password string) (*LoginPayload, error) {
	r, err := c.doJSON(http.MethodPost, path, map[string]string{
		"username": username,
		"password": password,
	}, false)
	if err != nil {
		return nil, err
	}
	if r.Code != CodeSuccess {
		msg := r.Text
		if msg == "" {
			msg = "用户名或密码错误"
		}
		return nil, fmt.Errorf("登录失败：%s", msg)
	}
	var p LoginPayload
	if err := json.Unmarshal(r.Payload, &p); err != nil {
		return nil, err
	}
	c.Token = p.Token
	return &p, nil
}

// ListSources 返回当前用户有查询权限的数据源（tp=query）。
// yee 的 Bind 会先按 json tag 绑定 query 参数，故用 ?tp=query 而非 GET body（更健壮）。
func (c *Client) ListSources() ([]Source, error) {
	r, err := c.doJSON(http.MethodGet, "/api/v2/fetch/source?tp=query", nil, true)
	if err != nil {
		return nil, err
	}
	if r.Code != CodeSuccess {
		return nil, fmt.Errorf("获取数据源失败：%s", r.Text)
	}
	var s []Source
	if err := json.Unmarshal(r.Payload, &s); err != nil {
		return nil, err
	}
	return s, nil
}

// ListSchemas 返回指定数据源下的库列表。
func (c *Client) ListSchemas(sourceID string) ([]TreeNode, error) {
	q := url.Values{"source_id": {sourceID}}
	r, err := c.doJSON(http.MethodGet, "/api/v2/query/schema?"+q.Encode(), nil, true)
	if err != nil {
		return nil, err
	}
	if r.Code != CodeSuccess {
		return nil, fmt.Errorf("获取库列表失败：%s", r.Text)
	}
	var nodes []TreeNode
	if err := json.Unmarshal(r.Payload, &nodes); err != nil {
		return nil, err
	}
	return nodes, nil
}

// ListTables 返回指定数据源、指定库下的表列表。
func (c *Client) ListTables(sourceID, schema string) ([]TreeNode, error) {
	q := url.Values{"source_id": {sourceID}, "schema": {schema}}
	r, err := c.doJSON(http.MethodGet, "/api/v2/query/tables?"+q.Encode(), nil, true)
	if err != nil {
		return nil, err
	}
	if r.Code != CodeSuccess {
		return nil, fmt.Errorf("获取表列表失败：%s", r.Text)
	}
	var wrap struct {
		Table []TreeNode `json:"table"`
	}
	if err := json.Unmarshal(r.Payload, &wrap); err != nil {
		return nil, err
	}
	return wrap.Table, nil
}

// EnsureQueryOrder 创建一张查询工单。
// 当 Yearning 关闭了查询审核时，后端会即时生成 status=2（已批准）的工单，
// 从而允许随后通过 WebSocket 执行查询；开启审核时则生成待审工单，需管理员批准。
func (c *Client) EnsureQueryOrder(sourceID, reason string) error {
	if reason == "" {
		reason = "yearning-cli query"
	}
	_, err := c.doJSON(http.MethodPost, "/api/v2/query/post", map[string]interface{}{
		"source_id": sourceID,
		"export":    0,
		"text":      reason,
	}, true)
	return err
}

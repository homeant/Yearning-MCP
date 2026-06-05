package client

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/vmihailenco/msgpack/v5"
	"golang.org/x/net/websocket"
)

// makeJWT 构造一个仅 exp 有效的 JWT（签名无所谓，客户端只本地解析 exp）。
func makeJWT(exp int64) string {
	enc := func(v interface{}) string {
		b, _ := json.Marshal(v)
		return base64.RawURLEncoding.EncodeToString(b)
	}
	return enc(map[string]string{"alg": "HS256"}) + "." + enc(map[string]int64{"exp": exp}) + ".sig"
}

// 与后端一致的请求结构，用于在测试服务端解码客户端发来的查询。
type serverRef struct {
	Type     int    `msgpack:"type"`
	Sql      string `msgpack:"sql"`
	Schema   string `msgpack:"schema"`
	SourceId string `msgpack:"source_id"`
}

func TestLoginAndSources(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["username"] != "admin" || body["password"] != "pass" {
			writeResp(w, Resp{Code: CodeLoginFail, Text: "用户名或密码错误"})
			return
		}
		writeResp(w, Resp{Code: CodeSuccess, Payload: mustJSON(LoginPayload{
			Token: "tok-123", RealName: "管理员", User: "admin", IsRecord: 1,
		})})
	})
	mux.HandleFunc("/ldap", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["username"] != "ldapuser" {
			writeResp(w, Resp{Code: CodeLoginFail, Text: "LDAP 认证失败"})
			return
		}
		writeResp(w, Resp{Code: CodeSuccess, Payload: mustJSON(LoginPayload{
			Token: "ldap-tok", RealName: "LDAP 用户", User: "ldapuser",
		})})
	})
	mux.HandleFunc("/api/v2/fetch/source", func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer tok-123" {
			t.Errorf("Authorization 头错误: %q", got)
		}
		writeResp(w, Resp{Code: CodeSuccess, Payload: mustJSON([]Source{
			{Source: "主库", IDC: "bj", SourceId: "mysql_01"},
		})})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := New(srv.URL, "")
	p, err := c.Login("admin", "pass")
	if err != nil {
		t.Fatalf("登录失败: %v", err)
	}
	if p.Token != "tok-123" || c.Token != "tok-123" {
		t.Fatalf("token 未正确保存: %+v", p)
	}

	sources, err := c.ListSources()
	if err != nil {
		t.Fatalf("获取数据源失败: %v", err)
	}
	if len(sources) != 1 || sources[0].SourceId != "mysql_01" {
		t.Fatalf("数据源解析错误: %+v", sources)
	}

	// 错误密码应返回明确错误。
	if _, err := New(srv.URL, "").Login("admin", "wrong"); err == nil {
		t.Fatal("错误密码应当登录失败")
	}

	// LDAP 登录走 /ldap 接口，契约一致。
	lp, err := New(srv.URL, "").LoginLDAP("ldapuser", "pw")
	if err != nil {
		t.Fatalf("LDAP 登录失败: %v", err)
	}
	if lp.Token != "ldap-tok" || lp.User != "ldapuser" {
		t.Fatalf("LDAP 登录解析错误: %+v", lp)
	}
}

func TestAutoReloginOn401(t *testing.T) {
	var loginCount int
	mux := http.NewServeMux()
	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		loginCount++
		writeResp(w, Resp{Code: CodeSuccess, Payload: mustJSON(LoginPayload{Token: "fresh", User: "admin"})})
	})
	mux.HandleFunc("/api/v2/fetch/source", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fresh" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		writeResp(w, Resp{Code: CodeSuccess, Payload: mustJSON([]Source{{SourceId: "s1"}})})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	var saved string
	c := NewWithAuth(srv.URL, "stale-token", &Credentials{Username: "admin", Password: "pw"}, func(tok string, exp int64) {
		saved = tok
	})
	sources, err := c.ListSources()
	if err != nil {
		t.Fatalf("应在 401 后自动重登成功: %v", err)
	}
	if len(sources) != 1 || sources[0].SourceId != "s1" {
		t.Fatalf("结果不符: %+v", sources)
	}
	if loginCount != 1 {
		t.Fatalf("应触发一次自动登录，实际 %d", loginCount)
	}
	if saved != "fresh" {
		t.Fatalf("onToken 应回传新 token，实际 %q", saved)
	}
}

func TestProactiveReloginOnExpiry(t *testing.T) {
	var loginCount int
	mux := http.NewServeMux()
	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		loginCount++
		writeResp(w, Resp{Code: CodeSuccess, Payload: mustJSON(LoginPayload{Token: "fresh", User: "admin"})})
	})
	mux.HandleFunc("/api/v2/fetch/source", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fresh" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		writeResp(w, Resp{Code: CodeSuccess, Payload: mustJSON([]Source{{SourceId: "s1"}})})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	// 传入一个已过期的 JWT：应在发请求“前”就主动重登（而非等 401）。
	expired := makeJWT(time.Now().Add(-time.Hour).Unix())
	c := NewWithAuth(srv.URL, expired, &Credentials{Username: "admin", Password: "pw"}, nil)
	if _, err := c.ListSources(); err != nil {
		t.Fatalf("过期应主动重登: %v", err)
	}
	if loginCount != 1 {
		t.Fatalf("应恰好主动登录一次，实际 %d", loginCount)
	}
}

func TestEnsureQueryOrderEmptyBody(t *testing.T) {
	// 关闭查询审核时，后端 ReferQueryOrder 成功后返回空 body。
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v2/query/post", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK) // 不写任何 body
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	if err := New(srv.URL, "tok").EnsureQueryOrder("src", "reason"); err != nil {
		t.Fatalf("空响应体应视为成功，却报错: %v", err)
	}
}

func TestQueryWebSocket(t *testing.T) {
	const token = "ws-token-abc"
	handler := websocket.Handler(func(ws *websocket.Conn) {
		// 校验 token 通过 Sec-WebSocket-Protocol 传递。
		if got := ws.Request().Header.Get("Sec-WebSocket-Protocol"); got != token {
			t.Errorf("Sec-WebSocket-Protocol 头错误: %q", got)
		}
		var b []byte
		if err := websocket.Message.Receive(ws, &b); err != nil {
			t.Errorf("服务端接收失败: %v", err)
			return
		}
		var ref serverRef
		if err := msgpack.Unmarshal(b, &ref); err != nil {
			t.Errorf("服务端解码失败: %v", err)
			return
		}
		if ref.Sql != "SELECT 1 AS n" || ref.Schema != "testdb" {
			t.Errorf("查询内容错误: %+v", ref)
		}
		out, _ := msgpack.Marshal(QueryResults{
			QueryTime: 7,
			Results: []*Query{{
				Field: []map[string]interface{}{{"title": "n"}},
				Data:  []map[string]interface{}{{"n": "1"}},
			}},
		})
		_ = websocket.Message.Send(ws, out)
	})
	srv := httptest.NewServer(handlerWithSource(handler))
	defer srv.Close()

	c := New(srv.URL, token)
	res, err := c.Query("mysql_01", "testdb", "SELECT 1 AS n")
	if err != nil {
		t.Fatalf("查询失败: %v", err)
	}
	if res.Error != "" || res.Status {
		t.Fatalf("查询返回异常: %+v", res)
	}
	if len(res.Results) != 1 || len(res.Results[0].Data) != 1 {
		t.Fatalf("结果集解析错误: %+v", res.Results)
	}
	if got := res.Results[0].Data[0]["n"]; got != "1" {
		t.Fatalf("数据值错误: %v", got)
	}
	if cols := res.Results[0].Columns(); len(cols) != 1 || cols[0] != "n" {
		t.Fatalf("列解析错误: %v", cols)
	}
}

// handlerWithSource 把 websocket handler 挂到 /api/v2/query/results 路径。
func handlerWithSource(h http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/api/v2/query/results", h)
	return mux
}

func writeResp(w http.ResponseWriter, r Resp) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(r)
}

func mustJSON(v interface{}) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

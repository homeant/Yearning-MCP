package client

import "encoding/json"

// 与 Yearning 后端约定的统一响应码。
const (
	CodeSuccess   = 1200 // 成功
	CodeLoginFail = 1301 // 登录失败
	CodeBindErr   = 1310 // 请求体解析失败
	CodeRPCErr    = 1311 // SQL 审核 RPC 调用失败
)

// Resp 是 Yearning 所有 HTTP 接口的统一响应信封。
type Resp struct {
	Payload json.RawMessage `json:"payload"`
	Code    int             `json:"code"`
	Text    string          `json:"text"`
}

// LoginPayload 为 POST /login 成功后的 payload。
type LoginPayload struct {
	Token    string `json:"token"`
	RealName string `json:"real_name"`
	User     string `json:"user"`
	IsRecord int    `json:"is_record"`
}

// Source 为 GET /api/v2/fetch/source 返回的数据源。
// 查询场景下后端仅 Select 了 source / id_c / source_id 三列，其余字段为零值。
type Source struct {
	Source   string `json:"source"`
	IDC      string `json:"idc"`
	SourceId string `json:"source_id"`
}

// TreeNode 为 schema / tables 接口返回的树节点。
type TreeNode struct {
	Title  string `json:"title"`
	Key    string `json:"key"`
	Meta   string `json:"meta"`
	IsLeaf bool   `json:"isLeaf"`
}

// queryRef 是通过 WebSocket 发送的查询请求体，msgpack 编码。
// 字段标签必须与后端 personal.QueryDeal.Ref 完全一致。
type queryRef struct {
	Type     int    `msgpack:"type"` // 0 conn 1 close
	Sql      string `msgpack:"sql"`
	Schema   string `msgpack:"schema"`
	SourceId string `msgpack:"source_id"`
}

// QueryResults 是 WebSocket 返回的查询结果，msgpack 编码。
type QueryResults struct {
	Export    bool     `msgpack:"export"`
	Error     string   `msgpack:"error"`
	Results   []*Query `msgpack:"results"`
	QueryTime int      `msgpack:"query_time"`
	Status    bool     `msgpack:"status"` // true 表示无有效查询工单（需创建/审批）
	HeartBeat string   `msgpack:"heartbeat"`
	IsOnly    bool     `msgpack:"is_only"`
}

// Query 为单条 SQL 的结果集：列定义 + 数据行。
type Query struct {
	Field []map[string]interface{} `msgpack:"field"`
	Data  []map[string]interface{} `msgpack:"data"`
}

// Columns 从 Field 中提取有序列名。
func (q *Query) Columns() []string {
	cols := make([]string, 0, len(q.Field))
	for _, f := range q.Field {
		if t, ok := f["title"].(string); ok {
			cols = append(cols, t)
		}
	}
	return cols
}

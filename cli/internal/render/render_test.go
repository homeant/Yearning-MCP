package render

import (
	"bytes"
	"strings"
	"testing"

	"yearning-cli/internal/client"
)

func sampleQuery() *client.Query {
	return &client.Query{
		Field: []map[string]interface{}{
			{"title": "id"},
			{"title": "name"},
		},
		Data: []map[string]interface{}{
			{"id": "1", "name": "alice"},
			{"id": "2", "name": nil}, // NULL 兜底
		},
	}
}

func TestTable(t *testing.T) {
	var b bytes.Buffer
	Table(&b, sampleQuery())
	out := b.String()
	for _, want := range []string{"id", "name", "alice", "NULL", "(2 行)"} {
		if !strings.Contains(out, want) {
			t.Errorf("表格输出缺少 %q\n%s", want, out)
		}
	}
}

func TestCSV(t *testing.T) {
	var b bytes.Buffer
	if err := CSV(&b, sampleQuery()); err != nil {
		t.Fatal(err)
	}
	got := b.String()
	if !strings.HasPrefix(got, "id,name\n") {
		t.Errorf("CSV 表头错误: %q", got)
	}
	if !strings.Contains(got, "1,alice") {
		t.Errorf("CSV 行错误: %q", got)
	}
}

func TestJSON(t *testing.T) {
	var b bytes.Buffer
	if err := JSON(&b, sampleQuery()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(b.String(), `"name": "alice"`) {
		t.Errorf("JSON 输出错误: %s", b.String())
	}
}

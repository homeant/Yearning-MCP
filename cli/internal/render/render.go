// Package render 负责把查询结果渲染成 table / json / csv。
package render

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"

	"yearning-cli/internal/client"
)

// cellString 将后端返回的单元格值转成字符串。后端已把多数类型转为字符串，
// 这里兜底处理 nil 与其它类型。
func cellString(v interface{}) string {
	switch t := v.(type) {
	case nil:
		return "NULL"
	case string:
		return t
	default:
		return fmt.Sprintf("%v", t)
	}
}

// Table 以对齐表格输出一个结果集。
func Table(w io.Writer, q *client.Query) {
	cols := q.Columns()
	if len(cols) == 0 {
		fmt.Fprintln(w, "(无列)")
		return
	}
	tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, strings.Join(cols, "\t"))
	// 分隔线
	seps := make([]string, len(cols))
	for i, c := range cols {
		seps[i] = strings.Repeat("-", len(c))
	}
	fmt.Fprintln(tw, strings.Join(seps, "\t"))
	for _, row := range q.Data {
		vals := make([]string, len(cols))
		for i, c := range cols {
			// 制表符会破坏列对齐，替换为空格。
			vals[i] = strings.ReplaceAll(cellString(row[c]), "\t", " ")
		}
		fmt.Fprintln(tw, strings.Join(vals, "\t"))
	}
	tw.Flush()
	fmt.Fprintf(w, "(%d 行)\n", len(q.Data))
}

// JSON 以 JSON 数组输出一个结果集（每行一个对象，保持列顺序无关）。
func JSON(w io.Writer, q *client.Query) error {
	cols := q.Columns()
	rows := make([]map[string]string, 0, len(q.Data))
	for _, row := range q.Data {
		m := make(map[string]string, len(cols))
		for _, c := range cols {
			m[c] = cellString(row[c])
		}
		rows = append(rows, m)
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(rows)
}

// CSV 以 CSV 输出一个结果集。
func CSV(w io.Writer, q *client.Query) error {
	cols := q.Columns()
	cw := csv.NewWriter(w)
	if err := cw.Write(cols); err != nil {
		return err
	}
	for _, row := range q.Data {
		rec := make([]string, len(cols))
		for i, c := range cols {
			rec[i] = cellString(row[c])
		}
		if err := cw.Write(rec); err != nil {
			return err
		}
	}
	cw.Flush()
	return cw.Error()
}

// Results 按指定格式渲染整个查询返回（可能含多个结果集）。
func Results(w io.Writer, format string, results []*client.Query) error {
	for i, q := range results {
		if q == nil {
			continue
		}
		if len(results) > 1 {
			fmt.Fprintf(w, "-- 结果集 %d --\n", i+1)
		}
		switch format {
		case "json":
			if err := JSON(w, q); err != nil {
				return err
			}
		case "csv":
			if err := CSV(w, q); err != nil {
				return err
			}
		default:
			Table(w, q)
		}
	}
	return nil
}

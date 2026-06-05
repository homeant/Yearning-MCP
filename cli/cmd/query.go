package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"yearning-cli/internal/render"
)

var (
	querySourceID string
	querySchema   string
	queryFormat   string
	queryFile     string
	queryReason   string
	queryNoOrder  bool
)

var queryCmd = &cobra.Command{
	Use:   "query [SQL]",
	Short: "执行 SQL 查询",
	Long: `通过 Yearning 执行一条查询型 SQL 并返回结果。

SQL 来源（按优先级）：命令行参数 > --file > 标准输入。

说明：
  - 查询会经过 Yearning 的 SQL 审核（RPC）与脱敏规则，敏感字段将显示为脱敏占位符。
  - 执行前默认会自动创建一张查询工单。若 Yearning 开启了查询审核，
    需管理员批准后才能查询；此时会提示并退出，可加 --no-order 跳过自动创建。`,
	RunE: func(cmd *cobra.Command, args []string) error {
		if querySourceID == "" {
			return fmt.Errorf("缺少数据源：请用 -s/--source 指定 source_id")
		}
		if querySchema == "" {
			return fmt.Errorf("缺少库名：请用 -d/--db 指定")
		}
		sql, err := resolveSQL(args)
		if err != nil {
			return err
		}
		if strings.TrimSpace(sql) == "" {
			return fmt.Errorf("没有要执行的 SQL")
		}
		switch queryFormat {
		case "table", "json", "csv":
		default:
			return fmt.Errorf("不支持的输出格式 %q（可选 table/json/csv）", queryFormat)
		}

		cli, _, err := newClient()
		if err != nil {
			return err
		}

		if !queryNoOrder {
			if err := cli.EnsureQueryOrder(querySourceID, queryReason); err != nil {
				return fmt.Errorf("创建查询工单失败：%w", err)
			}
		}

		res, err := cli.Query(querySourceID, querySchema, sql)
		if err != nil {
			return err
		}
		if res.Status {
			return fmt.Errorf("无有效查询工单：Yearning 可能开启了查询审核，请等待管理员批准后重试")
		}
		if res.Error != "" {
			return fmt.Errorf("查询出错：%s", res.Error)
		}
		if err := render.Results(os.Stdout, queryFormat, res.Results); err != nil {
			return err
		}
		if queryFormat == "table" {
			fmt.Fprintf(os.Stderr, "耗时 %d ms\n", res.QueryTime)
		}
		return nil
	},
}

// resolveSQL 依次从参数、--file、标准输入获取 SQL。
func resolveSQL(args []string) (string, error) {
	if len(args) > 0 {
		return strings.Join(args, " "), nil
	}
	if queryFile != "" {
		b, err := os.ReadFile(queryFile)
		if err != nil {
			return "", fmt.Errorf("读取 SQL 文件失败：%w", err)
		}
		return string(b), nil
	}
	// 标准输入（管道）。
	stat, _ := os.Stdin.Stat()
	if (stat.Mode() & os.ModeCharDevice) == 0 {
		b, err := io.ReadAll(os.Stdin)
		if err != nil {
			return "", err
		}
		return string(b), nil
	}
	return "", nil
}

func init() {
	queryCmd.Flags().StringVarP(&querySourceID, "source", "s", "", "数据源 source_id")
	queryCmd.Flags().StringVarP(&querySchema, "db", "d", "", "库名")
	queryCmd.Flags().StringVarP(&queryFormat, "format", "f", "table", "输出格式：table/json/csv")
	queryCmd.Flags().StringVar(&queryFile, "file", "", "从文件读取 SQL")
	queryCmd.Flags().StringVar(&queryReason, "reason", "", "查询工单说明")
	queryCmd.Flags().BoolVar(&queryNoOrder, "no-order", false, "不自动创建查询工单")
	rootCmd.AddCommand(queryCmd)
}

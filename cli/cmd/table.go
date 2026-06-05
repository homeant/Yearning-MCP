package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var (
	tableSourceID string
	tableSchema   string
)

var tableCmd = &cobra.Command{
	Use:   "table",
	Short: "表相关操作",
}

var tableListCmd = &cobra.Command{
	Use:   "list",
	Short: "列出指定数据源、指定库下的表",
	RunE: func(cmd *cobra.Command, args []string) error {
		if tableSourceID == "" {
			return fmt.Errorf("缺少数据源：请用 -s/--source 指定 source_id")
		}
		if tableSchema == "" {
			return fmt.Errorf("缺少库名：请用 -d/--db 指定")
		}
		cli, _, err := newClient()
		if err != nil {
			return err
		}
		nodes, err := cli.ListTables(tableSourceID, tableSchema)
		if err != nil {
			return err
		}
		if len(nodes) == 0 {
			fmt.Println("(无表)")
			return nil
		}
		for _, n := range nodes {
			fmt.Println(n.Title)
		}
		return nil
	},
}

func init() {
	tableListCmd.Flags().StringVarP(&tableSourceID, "source", "s", "", "数据源 source_id")
	tableListCmd.Flags().StringVarP(&tableSchema, "db", "d", "", "库名")
	tableCmd.AddCommand(tableListCmd)
	rootCmd.AddCommand(tableCmd)
}

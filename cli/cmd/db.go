package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var dbSourceID string

var dbCmd = &cobra.Command{
	Use:   "db",
	Short: "库（schema）相关操作",
}

var dbListCmd = &cobra.Command{
	Use:   "list",
	Short: "列出指定数据源下的库",
	RunE: func(cmd *cobra.Command, args []string) error {
		if dbSourceID == "" {
			return fmt.Errorf("缺少数据源：请用 -s/--source 指定 source_id")
		}
		cli, _, err := newClient()
		if err != nil {
			return err
		}
		nodes, err := cli.ListSchemas(dbSourceID)
		if err != nil {
			return err
		}
		if len(nodes) == 0 {
			fmt.Println("(无库)")
			return nil
		}
		for _, n := range nodes {
			fmt.Println(n.Title)
		}
		return nil
	},
}

func init() {
	dbListCmd.Flags().StringVarP(&dbSourceID, "source", "s", "", "数据源 source_id")
	dbCmd.AddCommand(dbListCmd)
	rootCmd.AddCommand(dbCmd)
}

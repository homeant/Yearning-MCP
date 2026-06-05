package cmd

import (
	"fmt"
	"os"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

var sourceCmd = &cobra.Command{
	Use:   "source",
	Short: "数据源相关操作",
}

var sourceListCmd = &cobra.Command{
	Use:   "list",
	Short: "列出当前用户可查询的数据源",
	RunE: func(cmd *cobra.Command, args []string) error {
		cli, _, err := newClient()
		if err != nil {
			return err
		}
		sources, err := cli.ListSources()
		if err != nil {
			return err
		}
		if len(sources) == 0 {
			fmt.Println("(无可查询的数据源)")
			return nil
		}
		tw := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
		fmt.Fprintln(tw, "SOURCE_ID\tSOURCE\tIDC")
		fmt.Fprintln(tw, "---------\t------\t---")
		for _, s := range sources {
			fmt.Fprintf(tw, "%s\t%s\t%s\n", s.SourceId, s.Source, s.IDC)
		}
		tw.Flush()
		return nil
	},
}

func init() {
	sourceCmd.AddCommand(sourceListCmd)
	rootCmd.AddCommand(sourceCmd)
}

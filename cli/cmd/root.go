// Package cmd 定义 yearning-cli 的命令行界面。
package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"yearning-cli/internal/client"
	"yearning-cli/internal/config"
)

var (
	flagEndpoint string
	flagToken    string
)

var rootCmd = &cobra.Command{
	Use:   "yearning-cli",
	Short: "通过 Yearning API 查询数据库数据的命令行工具",
	Long: `yearning-cli 通过 Yearning 的 HTTP/WebSocket 接口查询数据库数据。

它不直连数据库，所有操作都经过 Yearning 服务（复用其权限、脱敏与查询审计）。

无需单独登录：配置好地址与凭据后，命令会按需自动登录，token 缓存复用，
过期或被服务端拒绝时自动重新登录。

典型流程：
  1. yearning-cli config set -e http://127.0.0.1:8000 --username <用户> --password <密码>
  2. yearning-cli source list
  3. yearning-cli db list -s <source_id>
  4. yearning-cli query -s <source_id> -d <库名> "SELECT * FROM t LIMIT 10"`,
	SilenceUsage:  true,
	SilenceErrors: true,
}

// Execute 是程序入口。
func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "错误:", err)
		os.Exit(1)
	}
}

func init() {
	rootCmd.PersistentFlags().StringVarP(&flagEndpoint, "endpoint", "e", "", "Yearning 服务地址（覆盖配置文件，亦可用 YEARNING_ENDPOINT）")
	rootCmd.PersistentFlags().StringVar(&flagToken, "token", "", "JWT token（覆盖配置文件，亦可用 YEARNING_TOKEN）")
}

// loadConfig 读取配置并应用命令行 flag 覆盖。
func loadConfig() (*config.Config, error) {
	c, err := config.Load()
	if err != nil {
		return nil, err
	}
	if flagEndpoint != "" {
		c.Endpoint = flagEndpoint
	}
	if flagToken != "" {
		c.Token = flagToken
		c.TokenExp = 0
	}
	return c, nil
}

// newClient 构建带自动登录能力的客户端：携带缓存 token 与凭据，
// 自动登录后通过回调把新 token 持久化回 credentials.json。
func newClient() (*client.Client, *config.Config, error) {
	c, err := loadConfig()
	if err != nil {
		return nil, nil, err
	}
	if c.Endpoint == "" {
		return nil, nil, fmt.Errorf("未配置 Yearning 地址：请用 `yearning-cli config set -e <地址>` 设置")
	}

	var creds *client.Credentials
	if c.Username != "" {
		creds = &client.Credentials{Username: c.Username, Password: c.Password, LDAP: c.LDAP}
	}
	// token 由 --token/env 提供时不回写文件（不污染用户的凭据缓存）。
	persist := flagToken == "" && os.Getenv("YEARNING_TOKEN") == ""
	onToken := func(token string, exp int64) {
		if !persist {
			return
		}
		if err := config.SaveToken(token, exp); err != nil {
			fmt.Fprintln(os.Stderr, "警告：缓存 token 失败：", err)
		}
	}

	cli := client.NewWithAuth(c.Endpoint, c.Token, creds, onToken)
	return cli, c, nil
}

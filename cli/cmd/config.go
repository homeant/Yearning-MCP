package cmd

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"yearning-cli/internal/config"
)

var configCmd = &cobra.Command{
	Use:   "config",
	Short: "查看与维护 CLI 配置（服务端地址、登录凭据）",
	Long: `维护 yearning-cli 的配置。

配置分两份：
  - config.toml      非敏感（服务端地址），可共享/提交，亦可手工编辑
  - credentials.json  登录凭据（用户名/密码/是否 LDAP）与缓存 token（0600）

配置好凭据后无需单独登录：命令会按需自动登录，token 过期会自动重登。`,
}

var (
	configSetUsername string
	configSetPassword string
	configSetLDAP     bool
	configInitForce   bool
)

var configShowCmd = &cobra.Command{
	Use:   "show",
	Short: "显示当前有效配置及文件路径",
	RunE: func(cmd *cobra.Command, args []string) error {
		c, err := loadConfig()
		if err != nil {
			return err
		}
		fmt.Printf("配置文件:   %s\n", config.ConfigPath())
		fmt.Printf("凭据文件:   %s\n", config.CredentialsPath())
		fmt.Printf("服务端地址: %s\n", orNone(c.Endpoint))
		fmt.Printf("用户名:     %s\n", orNone(c.Username))
		fmt.Printf("密码:       %s\n", maskSecret(c.Password))
		fmt.Printf("LDAP:       %v\n", c.LDAP)
		fmt.Printf("缓存 Token: %s\n", maskToken(c.Token))
		exp := c.TokenExp
		if exp == 0 {
			exp = jwtExp(c.Token) // 旧凭据文件未存 exp 时，从 token 解析
		}
		fmt.Printf("Token 过期: %s\n", expHint(exp))
		return nil
	},
}

var configSetCmd = &cobra.Command{
	Use:   "set",
	Short: "设置服务端地址与登录凭据",
	Long: `设置服务端地址（写入 config.toml）与登录凭据（写入 credentials.json，0600）。

可分别设置，例如：
  yearning-cli config set -e http://127.0.0.1:8000
  yearning-cli config set --username admin --password 'secret'
  yearning-cli config set --username alice --password 'secret' --ldap`,
	RunE: func(cmd *cobra.Command, args []string) error {
		changed := false
		if flagEndpoint != "" {
			if err := config.SaveEndpoint(flagEndpoint); err != nil {
				return err
			}
			fmt.Printf("服务端地址已写入 %s：%s\n", config.ConfigPath(), flagEndpoint)
			changed = true
		}
		// 用户名/密码/LDAP 任一被显式指定即更新凭据（会清空旧缓存 token）。
		if cmd.Flags().Changed("username") || cmd.Flags().Changed("password") || cmd.Flags().Changed("ldap") {
			if configSetUsername == "" {
				return fmt.Errorf("设置凭据需同时提供 --username")
			}
			if err := config.SaveLogin(configSetUsername, configSetPassword, configSetLDAP); err != nil {
				return err
			}
			fmt.Printf("登录凭据已写入 %s（0600）：用户 %s，LDAP=%v\n", config.CredentialsPath(), configSetUsername, configSetLDAP)
			changed = true
		}
		if !changed {
			return fmt.Errorf("未指定任何配置项：可用 --endpoint / --username / --password / --ldap")
		}
		return nil
	},
}

var configInitCmd = &cobra.Command{
	Use:   "init",
	Short: "生成配置模板文件",
	RunE: func(cmd *cobra.Command, args []string) error {
		ep := flagEndpoint
		if ep == "" {
			ep = "http://127.0.0.1:8000"
		}
		if err := config.WriteTemplate(ep, configInitForce); err != nil {
			return err
		}
		fmt.Printf("已生成配置模板：%s\n请按需编辑其中的 endpoint，再用 `config set --username ... --password ...` 设置凭据。\n", config.ConfigPath())
		return nil
	},
}

func orNone(s string) string {
	if s == "" {
		return "(未设置)"
	}
	return s
}

func maskSecret(s string) string {
	if s == "" {
		return "(未设置)"
	}
	return "******"
}

// maskToken 只显示 token 头尾，避免在终端完整回显。
func maskToken(t string) string {
	if t == "" {
		return "(无)"
	}
	if len(t) <= 12 {
		return "******"
	}
	return t[:6] + "…" + t[len(t)-4:]
}

// jwtExp 从 JWT 解析 exp（Unix 秒），失败返回 0。
func jwtExp(token string) int64 {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return 0
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return 0
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if json.Unmarshal(payload, &claims) != nil {
		return 0
	}
	return claims.Exp
}

func expHint(exp int64) string {
	if exp == 0 {
		return "(未知)"
	}
	t := time.Unix(exp, 0)
	if time.Now().After(t) {
		return t.Format("2006-01-02 15:04") + "（已过期，下次请求将自动重登）"
	}
	return t.Format("2006-01-02 15:04")
}

func init() {
	// 服务端地址复用全局持久化 flag -e/--endpoint。
	configSetCmd.Flags().StringVarP(&configSetUsername, "username", "u", "", "登录用户名")
	configSetCmd.Flags().StringVarP(&configSetPassword, "password", "p", "", "登录密码")
	configSetCmd.Flags().BoolVar(&configSetLDAP, "ldap", false, "使用 LDAP 登录")
	configInitCmd.Flags().BoolVar(&configInitForce, "force", false, "已存在时覆盖")
	configCmd.AddCommand(configShowCmd, configSetCmd, configInitCmd)
	rootCmd.AddCommand(configCmd)
}

// Package config 管理 CLI 配置，拆成两份：
//   - config.toml：服务端地址等非敏感配置，可共享/提交，可手工编辑或用 `config` 命令维护。
//   - credentials.json：登录凭据（用户名/密码/是否 LDAP）与自动登录后缓存的 token（0600）。
//
// CLI 不再有独立 login 命令：配置好凭据后，首次需要鉴权的命令会自动登录，
// token 与过期时间缓存进 credentials.json，后续命令复用，过期或被 401 时自动重登。
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"
)

// Config 是合并文件与环境变量后的有效运行配置。
type Config struct {
	Endpoint string // config.toml / YEARNING_ENDPOINT
	Username string // credentials.json / YEARNING_USERNAME
	Password string // credentials.json / YEARNING_PASSWORD
	LDAP     bool   // credentials.json / YEARNING_LDAP
	Token    string // credentials.json 缓存 / YEARNING_TOKEN
	TokenExp int64  // credentials.json 缓存的 JWT exp（Unix 秒），仅用于展示
}

// fileConfig 对应 config.toml 的结构（非敏感）。
type fileConfig struct {
	Endpoint string `toml:"endpoint"`
}

// credentials 对应 credentials.json 的结构（敏感，0600）。
type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
	LDAP     bool   `json:"ldap"`
	Token    string `json:"token,omitempty"`
	TokenExp int64  `json:"token_exp,omitempty"`
}

func dir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".yearning-cli"
	}
	return filepath.Join(home, ".yearning-cli")
}

// ConfigPath 返回 config.toml 路径，可用 YEARNING_CLI_CONFIG 覆盖。
func ConfigPath() string {
	if p := os.Getenv("YEARNING_CLI_CONFIG"); p != "" {
		return p
	}
	return filepath.Join(dir(), "config.toml")
}

// CredentialsPath 返回 credentials.json 路径，可用 YEARNING_CLI_CREDENTIALS 覆盖。
func CredentialsPath() string {
	if p := os.Getenv("YEARNING_CLI_CREDENTIALS"); p != "" {
		return p
	}
	return filepath.Join(dir(), "credentials.json")
}

// readCreds 读取 credentials.json，文件缺失返回空结构。
func readCreds() (credentials, error) {
	var cr credentials
	b, err := os.ReadFile(CredentialsPath())
	if err != nil {
		if os.IsNotExist(err) {
			return cr, nil
		}
		return cr, fmt.Errorf("读取凭据文件失败 %s: %w", CredentialsPath(), err)
	}
	if err := json.Unmarshal(b, &cr); err != nil {
		return cr, fmt.Errorf("解析凭据文件失败 %s: %w", CredentialsPath(), err)
	}
	return cr, nil
}

func writeCreds(cr credentials) error {
	p := CredentialsPath()
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(cr, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, b, 0o600)
}

// Load 读取两份文件并应用环境变量覆盖。文件缺失视为空配置，不报错。
func Load() (*Config, error) {
	c := &Config{}

	var fc fileConfig
	if _, err := toml.DecodeFile(ConfigPath(), &fc); err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("解析配置文件失败 %s: %w", ConfigPath(), err)
	}
	c.Endpoint = fc.Endpoint

	cr, err := readCreds()
	if err != nil {
		return nil, err
	}
	c.Username = cr.Username
	c.Password = cr.Password
	c.LDAP = cr.LDAP
	c.Token = cr.Token
	c.TokenExp = cr.TokenExp

	if v := os.Getenv("YEARNING_ENDPOINT"); v != "" {
		c.Endpoint = v
	}
	if v := os.Getenv("YEARNING_USERNAME"); v != "" {
		c.Username = v
	}
	if v := os.Getenv("YEARNING_PASSWORD"); v != "" {
		c.Password = v
	}
	if v := os.Getenv("YEARNING_LDAP"); v != "" {
		c.LDAP = v == "1" || v == "true" || v == "yes" || v == "on"
	}
	if v := os.Getenv("YEARNING_TOKEN"); v != "" {
		c.Token = v
		c.TokenExp = 0
	}
	return c, nil
}

// configTemplate 是带注释的 config.toml 模板；%s 处填入 endpoint。
const configTemplate = `# yearning-cli 配置文件
# 此文件仅含非敏感配置，可安全提交/共享。登录凭据另存于 credentials.json。

# Yearning 服务地址（含协议与端口），例如 http://127.0.0.1:8000
endpoint = "%s"
`

// SaveEndpoint 把 endpoint 写入 config.toml（保留注释模板）。
func SaveEndpoint(endpoint string) error {
	p := ConfigPath()
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	return os.WriteFile(p, []byte(fmt.Sprintf(configTemplate, endpoint)), 0o644)
}

// WriteTemplate 写出一份配置模板。force=false 且文件已存在时返回错误，避免覆盖。
func WriteTemplate(endpoint string, force bool) error {
	p := ConfigPath()
	if !force {
		if _, err := os.Stat(p); err == nil {
			return fmt.Errorf("配置文件已存在：%s（如需覆盖请加 --force）", p)
		}
	}
	return SaveEndpoint(endpoint)
}

// SaveLogin 写入登录凭据（用户名/密码/是否 LDAP），并清空旧的缓存 token。
// 密码以明文存储，靠 credentials.json 的 0600 权限保护。
func SaveLogin(username, password string, ldap bool) error {
	cr, err := readCreds()
	if err != nil {
		return err
	}
	cr.Username = username
	cr.Password = password
	cr.LDAP = ldap
	cr.Token = ""
	cr.TokenExp = 0
	return writeCreds(cr)
}

// SaveToken 仅更新缓存的 token 与过期时间，保留用户名/密码/LDAP 设置。
// 供客户端自动登录成功后的回调持久化使用。
func SaveToken(token string, exp int64) error {
	cr, err := readCreds()
	if err != nil {
		return err
	}
	cr.Token = token
	cr.TokenExp = exp
	return writeCreds(cr)
}

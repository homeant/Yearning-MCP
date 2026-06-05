package config

import (
	"path/filepath"
	"testing"
)

func TestSaveLoadRoundTrip(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("YEARNING_CLI_CONFIG", filepath.Join(tmp, "config.toml"))
	t.Setenv("YEARNING_CLI_CREDENTIALS", filepath.Join(tmp, "credentials.json"))

	if err := SaveEndpoint("http://example:8000"); err != nil {
		t.Fatal(err)
	}
	if err := SaveLogin("alice", "pw", true); err != nil {
		t.Fatal(err)
	}
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.Endpoint != "http://example:8000" || c.Username != "alice" || c.Password != "pw" || !c.LDAP {
		t.Fatalf("读取结果不符: %+v", c)
	}
}

func TestSaveTokenPreservesLogin(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("YEARNING_CLI_CREDENTIALS", filepath.Join(tmp, "credentials.json"))

	if err := SaveLogin("bob", "secret", false); err != nil {
		t.Fatal(err)
	}
	// 缓存 token 不应抹掉用户名/密码。
	if err := SaveToken("tok-abc", 1893456000); err != nil {
		t.Fatal(err)
	}
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.Username != "bob" || c.Password != "secret" || c.Token != "tok-abc" || c.TokenExp != 1893456000 {
		t.Fatalf("SaveToken 应保留凭据并写入 token: %+v", c)
	}

	// 重新设置凭据应清空旧缓存 token。
	if err := SaveLogin("bob", "newpw", false); err != nil {
		t.Fatal(err)
	}
	c2, _ := Load()
	if c2.Token != "" || c2.TokenExp != 0 {
		t.Fatalf("改凭据后应清空缓存 token: %+v", c2)
	}
}

func TestEnvOverride(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("YEARNING_CLI_CONFIG", filepath.Join(tmp, "config.toml"))
	t.Setenv("YEARNING_CLI_CREDENTIALS", filepath.Join(tmp, "credentials.json"))
	_ = SaveEndpoint("http://file:8000")

	t.Setenv("YEARNING_ENDPOINT", "http://env:9000")
	t.Setenv("YEARNING_TOKEN", "env-token")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.Endpoint != "http://env:9000" || c.Token != "env-token" {
		t.Fatalf("环境变量未覆盖: %+v", c)
	}
}

func TestMissingFilesNoError(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("YEARNING_CLI_CONFIG", filepath.Join(tmp, "nope.toml"))
	t.Setenv("YEARNING_CLI_CREDENTIALS", filepath.Join(tmp, "nope.json"))
	c, err := Load()
	if err != nil {
		t.Fatalf("文件缺失不应报错: %v", err)
	}
	if c.Endpoint != "" || c.Token != "" {
		t.Fatalf("应为空配置: %+v", c)
	}
}

func TestWriteTemplateNoOverwrite(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("YEARNING_CLI_CONFIG", filepath.Join(tmp, "config.toml"))
	if err := WriteTemplate("http://a", false); err != nil {
		t.Fatal(err)
	}
	if err := WriteTemplate("http://b", false); err == nil {
		t.Fatal("已存在时应拒绝覆盖")
	}
	if err := WriteTemplate("http://b", true); err != nil {
		t.Fatalf("force 应允许覆盖: %v", err)
	}
}

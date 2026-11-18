package config

import (
	"bytes"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func caseEnv(t *testing.T, name string) map[string]string {
	t.Helper()
	cases, _ := loadGolden(t)
	for _, c := range cases {
		if c.Name == name {
			return c.Env
		}
	}
	t.Fatalf("no golden case %q", name)
	return nil
}

// TestErrorsNeverEchoValues: a refused env names keys only. No value of four or more characters from the
// case may appear in the error text.
func TestErrorsNeverEchoValues(t *testing.T) {
	cases, results := loadGolden(t)
	for _, c := range cases {
		if results[c.Name].OK {
			continue
		}
		_, err := Load(c.Env)
		if err == nil {
			continue // REDIS_URL-only refusals are accepted by Go (parity test covers that)
		}
		for k, v := range c.Env {
			if len(v) >= 4 && strings.Contains(err.Error(), v) {
				t.Errorf("%s: error %q contains the value of %s", c.Name, err.Error(), k)
			}
		}
	}
}

func TestInvalidErrorMessage(t *testing.T) {
	_, err := Load(map[string]string{})
	var inv *InvalidError
	if !errors.As(err, &inv) {
		t.Fatalf("want *InvalidError, got %v", err)
	}
	if !strings.HasPrefix(err.Error(), "Invalid configuration: DATABASE_URL, HERMES_IMAGE, ADMIN_TOKEN, HERMES_MASTER_KEY") {
		t.Fatalf("message = %q", err.Error())
	}
}

// TestLogValueHasNoSecrets: logging a fully configured Config must not leak any secret (Review Focus 4).
func TestLogValueHasNoSecrets(t *testing.T) {
	env := caseEnv(t, "production-full")
	cfg, err := Load(env)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	slog.New(slog.NewJSONHandler(&buf, nil)).Info("config", "config", cfg)
	out := buf.String()
	for _, k := range []string{
		"ADMIN_TOKEN", "HERMES_MASTER_KEY", "SECRETS_KEK", "SECRETS_KEK_PREVIOUS", "SUMOPOD_SMTP_PASS", "DUITKU_API_KEY",
		"SUMOPOD_API_KEY", "SUMOPOD_WEBHOOK_TOKEN", "SUMOPOD_WEBHOOK_SECRET", "NIBIEROUTER_ADMIN_KEY",
		"OPS_TELEGRAM_BOT_TOKEN", "TURNSTILE_SECRET_KEY", "DATABASE_URL",
	} {
		if v := env[k]; v == "" {
			t.Fatalf("case production-full has no %s", k)
		} else if strings.Contains(out, v) {
			t.Errorf("log output contains the value of %s", k)
		}
	}
	for _, want := range []string{`"nodeEnv":"production"`, `"billing":true`, `"secrets":true`} {
		if !strings.Contains(out, want) {
			t.Errorf("log output lacks %s: %s", want, out)
		}
	}
	if s := cfg.String(); strings.Contains(s, env["ADMIN_TOKEN"]) {
		t.Errorf("String() leaks ADMIN_TOKEN")
	}
}

func TestRedisURLIgnored(t *testing.T) {
	base := caseEnv(t, "base")
	plain, err := Load(base)
	if err != nil {
		t.Fatal(err)
	}
	if plain.RedisURLIgnored {
		t.Fatal("RedisURLIgnored set without REDIS_URL")
	}
	withRedis := map[string]string{"REDIS_URL": "http://not-redis.example.test"}
	for k, v := range base {
		withRedis[k] = v
	}
	cfg, err := Load(withRedis)
	if err != nil {
		t.Fatalf("REDIS_URL must be ignored, got %v", err)
	}
	if !cfg.RedisURLIgnored {
		t.Fatal("RedisURLIgnored not set")
	}
	if !reflect.DeepEqual(parityJSON(t, cfg), parityJSON(t, plain)) {
		t.Fatal("REDIS_URL changed something besides RedisURLIgnored")
	}
}

func TestFromEnvironReadsDotEnvOutsideProduction(t *testing.T) {
	base := caseEnv(t, "base")
	dir := t.TempDir()
	t.Chdir(dir)
	for k, v := range base {
		if k != "ADMIN_TOKEN" {
			t.Setenv(k, v)
		}
	}
	t.Setenv("PORT", "4100")
	dotenv := "# comment\nADMIN_TOKEN=\"" + strings.Repeat("d", 24) + "\"\nPORT=4200\n\nexport IGNORED_EXPORT=1\n"
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(dotenv), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := FromEnviron()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AdminToken != strings.Repeat("d", 24) {
		t.Fatal(".env value not loaded")
	}
	if cfg.Port != 4100 {
		t.Fatalf("process env must win over .env, port = %d", cfg.Port)
	}

	t.Setenv("NODE_ENV", "production")
	if _, err := FromEnviron(); err == nil || !strings.Contains(err.Error(), "ADMIN_TOKEN") {
		t.Fatalf("production must not read .env; err = %v", err)
	}
}

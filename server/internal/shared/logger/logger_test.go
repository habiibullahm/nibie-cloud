package logger

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
)

// Port of test/unit/logger.test.ts 'redacts tokens, api keys, env values and authorization headers'.
func TestRedactsTokensKeysEnvAndAuthorization(t *testing.T) {
	var buf bytes.Buffer
	log := New(&buf, slog.LevelInfo)
	log.Info("hello",
		"adminToken", "sekret-admin",
		slog.Group("env", "TELEGRAM_BOT_TOKEN", "sekret-bot"),
		slog.Group("provider", "apiKey", "sekret-key", "password", "sekret-pw", "token", "sekret-tok"),
		slog.Group("req", slog.Group("headers", "authorization", "Bearer sekret-bearer")),
	)
	// The same shapes passed as plain maps (not slog groups) must be redacted too.
	log.Info("maps",
		"provider", map[string]any{"apiKey": "sekret-map-key", "name": "kept-name"},
		"env", map[string]string{"SMTP_PASS": "sekret-map-env"},
		"headers", map[string]any{"authorization": "Bearer sekret-map-bearer"},
	)
	out := buf.String()
	for _, s := range []string{"sekret-admin", "sekret-bot", "sekret-key", "sekret-pw", "sekret-tok", "sekret-bearer", "sekret-map-key", "sekret-map-env", "sekret-map-bearer"} {
		if strings.Contains(out, s) {
			t.Errorf("output contains %q:\n%s", s, out)
		}
	}
	for _, s := range []string{"[REDACTED]", "hello", "kept-name"} {
		if !strings.Contains(out, s) {
			t.Errorf("output lacks %q:\n%s", s, out)
		}
	}
}

func TestKeepsOrdinaryFields(t *testing.T) {
	var buf bytes.Buffer
	New(&buf, slog.LevelInfo).Info("started", "token_count", 3, slog.Group("a", slog.Group("b", "token", "deep-value")))
	out := buf.String()
	// Only the documented paths are redacted: a depth-2 "token" is not one of them (as in pino).
	for _, s := range []string{`"token_count":3`, "deep-value"} {
		if !strings.Contains(out, s) {
			t.Errorf("output lacks %q:\n%s", s, out)
		}
	}
	var line map[string]any
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatal(err)
	}
	if line["level"] != "INFO" || line["msg"] != "started" {
		t.Fatalf("line = %v", line)
	}
	if ts, _ := line["time"].(string); len(ts) != len("2006-01-02T15:04:05.000Z") || !strings.HasSuffix(ts, "Z") {
		t.Fatalf("time = %q, want UTC RFC 3339 with milliseconds", ts)
	}
}

func TestParseLevel(t *testing.T) {
	for in, want := range map[string]slog.Level{"debug": slog.LevelDebug, "info": slog.LevelInfo, "warn": slog.LevelWarn, "error": slog.LevelError, "": slog.LevelInfo, "loud": slog.LevelInfo} {
		if got := ParseLevel(in); got != want {
			t.Errorf("ParseLevel(%q) = %v, want %v", in, got, want)
		}
	}
}

// Port of test/unit/logger.test.ts 'request log'.
func TestRequestAttrDropsQueryAndPort(t *testing.T) {
	var buf bytes.Buffer
	r := httptest.NewRequest("GET", "/api/v1/admin/customers?q=alice@example.test", nil)
	r.RemoteAddr = "203.0.113.77:51234"
	New(&buf, slog.LevelInfo).Info("request", RequestAttr(r))
	out := buf.String()
	for _, s := range []string{`"url":"/api/v1/admin/customers"`, `"remoteAddress":"203.0.113.0"`, `"method":"GET"`} {
		if !strings.Contains(out, s) {
			t.Errorf("output lacks %s:\n%s", s, out)
		}
	}
	for _, s := range []string{"alice@example.test", "203.0.113.77", "51234"} {
		if strings.Contains(out, s) {
			t.Errorf("output contains %q:\n%s", s, out)
		}
	}
}

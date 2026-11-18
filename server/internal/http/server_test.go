package http

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/habiibullahm/nibie-cloud/server/internal/shared/logger"
)

func TestHealthz(t *testing.T) {
	h := NewHandler(Deps{Log: slog.New(slog.DiscardHandler)})
	rec := get(t, h, "/healthz")
	if rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"status":"ok"}` {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("content-type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("content-type = %q", ct)
	}
}

func TestReadyzIsWired(t *testing.T) {
	h := NewHandler(Deps{Log: slog.New(slog.DiscardHandler), Checks: []Check{{"database", ok}}})
	if rec := get(t, h, "/readyz"); rec.Code != 200 {
		t.Fatalf("/readyz = %d", rec.Code)
	}
	if rec := get(t, h, "/nope"); rec.Code != 404 {
		t.Fatalf("/nope = %d", rec.Code)
	}
}

// TestRequestLogLine: one JSON line per request, with the path but not the query string or the client port.
func TestRequestLogLine(t *testing.T) {
	var buf bytes.Buffer
	h := NewHandler(Deps{Log: logger.New(&buf, slog.LevelInfo)})
	r := httptest.NewRequest("GET", "/healthz?email=alice@example.test", nil)
	r.RemoteAddr = "203.0.113.77:51234"
	h.ServeHTTP(httptest.NewRecorder(), r)
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("want one log line, got %d:\n%s", len(lines), buf.String())
	}
	var line struct {
		Msg    string            `json:"msg"`
		Status int               `json:"status"`
		Req    map[string]string `json:"req"`
	}
	if err := json.Unmarshal([]byte(lines[0]), &line); err != nil {
		t.Fatal(err)
	}
	if line.Req["url"] != "/healthz" || line.Req["remoteAddress"] != "203.0.113.0" || line.Status != 200 {
		t.Fatalf("log line = %s", lines[0])
	}
	if strings.Contains(buf.String(), "alice@example.test") || strings.Contains(buf.String(), "51234") {
		t.Fatalf("log line leaks the query or the port: %s", lines[0])
	}
}

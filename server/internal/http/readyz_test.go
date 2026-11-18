package http

import (
	"context"
	"errors"
	nethttp "net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func get(t *testing.T, h nethttp.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
	return rec
}

func ok(context.Context) error { return nil }

// Port of test/unit/readyz.test.ts 'answers 200 ok when every check passes, and with no checks'.
func TestReadyzOK(t *testing.T) {
	for _, checks := range [][]Check{nil, {{"database", ok}, {"docker", ok}}} {
		rec := get(t, Readyz(checks, ReadyzTimeout), "/readyz")
		if rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"status":"ok"}` {
			t.Fatalf("%d %s", rec.Code, rec.Body.String())
		}
		if rec.Header().Get("cache-control") != "no-store" {
			t.Fatalf("cache-control = %q", rec.Header().Get("cache-control"))
		}
	}
}

// Port of 'answers 503 with only the failing names, never an error message'.
func TestReadyzFailNamesOnly(t *testing.T) {
	checks := []Check{
		{"database", func(context.Context) error { return errors.New("password=hunter2 host=10.0.0.5") }},
		{"docker", ok},
		{"river", func(context.Context) error { return errors.New("down") }},
	}
	rec := get(t, Readyz(checks, ReadyzTimeout), "/readyz")
	if rec.Code != 503 || strings.TrimSpace(rec.Body.String()) != `{"status":"fail","failed":["database","river"]}` {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "hunter2") || strings.Contains(rec.Body.String(), "10.0.0.5") {
		t.Fatal("body leaks the error message")
	}
}

// Port of 'counts a check that never answers as failed once the timeout passes' (Review Focus 5).
func TestReadyzTimeout(t *testing.T) {
	hang := func(context.Context) error { select {} } // ignores its context on purpose
	start := time.Now()
	rec := get(t, Readyz([]Check{{"database", hang}, {"docker", ok}}, 100*time.Millisecond), "/readyz")
	if took := time.Since(start); took > 600*time.Millisecond {
		t.Fatalf("took %s, want about the timeout", took)
	}
	if rec.Code != 503 || strings.TrimSpace(rec.Body.String()) != `{"status":"fail","failed":["database"]}` {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

//go:build integration

package db

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/habiibullahm/nibie-cloud/server/internal/testutil/pgtest"
	"github.com/jackc/pgx/v5"
)

func TestOpenSetsSearchPath(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	url := pgtest.Fresh(t, "")
	c, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Exec(ctx, `CREATE SCHEMA m0_probe`); err != nil {
		t.Fatal(err)
	}
	c.Close(ctx)

	var logs bytes.Buffer
	pool, err := Open(ctx, url+"?schema=m0_probe&pgbouncer=true&connection_limit=3", MaxConns, slog.New(slog.NewJSONHandler(&logs, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	for range 3 { // every pooled connection, not only the first
		var schema string
		if err := pool.QueryRow(ctx, `SELECT current_schema()`).Scan(&schema); err != nil {
			t.Fatal(err)
		}
		if schema != "m0_probe" {
			t.Fatalf("current_schema() = %q", schema)
		}
	}
	if pool.Config().MaxConns != MaxConns {
		t.Fatalf("MaxConns = %d", pool.Config().MaxConns)
	}
	out := logs.String()
	if !strings.Contains(out, "connection_limit") || !strings.Contains(out, "pgbouncer") || strings.Contains(out, "hermes_dev_only") {
		t.Fatalf("log line = %s", out)
	}
}

func TestOpenFailsWithoutLeakingPassword(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, err := Open(ctx, "postgresql://hermes:wrong-secret-pw@127.0.0.1:1/none", MaxConns, slog.New(slog.DiscardHandler))
	if err == nil {
		t.Fatal("want an error")
	}
	if strings.Contains(err.Error(), "wrong-secret-pw") {
		t.Fatalf("error leaks the password: %v", err)
	}
}

// Package pgtest gives integration tests a fresh, empty Postgres database that is dropped afterwards.
// It reads HERMES_TEST_DATABASE_URL (default: the compose dev database hermes_test on 127.0.0.1:5433),
// whose role must be allowed to create databases.
package pgtest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

const defaultURL = "postgresql://hermes:hermes_dev_only@127.0.0.1:5433/hermes_test"

// AdminURL is the database used to create and drop the fresh ones.
func AdminURL() string {
	if v := os.Getenv("HERMES_TEST_DATABASE_URL"); v != "" {
		return v
	}
	return defaultURL
}

// WithDatabase returns AdminURL with its database name replaced.
func WithDatabase(t testing.TB, name string) string {
	t.Helper()
	u, err := url.Parse(AdminURL())
	if err != nil {
		t.Fatalf("HERMES_TEST_DATABASE_URL: %v", err)
	}
	u.Path = "/" + name
	return u.String()
}

// Fresh creates database hermes_m0_<random hex> (optionally as a copy of template) and returns its URL.
// The database is dropped when the test ends.
func Fresh(t testing.TB, template string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, AdminURL())
	if err != nil {
		t.Fatalf("connect to the test database (is `docker compose up -d postgres` running?): %v", err)
	}
	defer admin.Close(ctx)
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	name := "hermes_m0_" + hex.EncodeToString(b)
	stmt := "CREATE DATABASE " + pgx.Identifier{name}.Sanitize()
	if template != "" {
		stmt += " TEMPLATE " + pgx.Identifier{template}.Sanitize()
	}
	if _, err := admin.Exec(ctx, stmt); err != nil {
		t.Fatalf("create %s: %v", name, err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		c, err := pgx.Connect(ctx, AdminURL())
		if err != nil {
			t.Logf("drop %s: %v", name, err)
			return
		}
		defer c.Close(ctx)
		if _, err := c.Exec(ctx, "DROP DATABASE IF EXISTS "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)"); err != nil {
			t.Logf("drop %s: %v", name, err)
		}
	})
	return WithDatabase(t, name)
}

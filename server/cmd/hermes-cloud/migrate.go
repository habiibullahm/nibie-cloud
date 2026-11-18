package main

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"log/slog"
	"os"
	"time"

	"github.com/habiibullahm/nibie-cloud/server/internal/db"
	"github.com/habiibullahm/nibie-cloud/server/internal/db/migrate"
	"github.com/jackc/pgx/v5/stdlib"
)

// runMigrate runs `migrate up|baseline|status`. It reads only DATABASE_URL (not the whole config), so it
// works inside `docker compose run` with the production env file. Exit 0 on success, 1 on error; errors
// never print the URL.
func runMigrate(action string, stdout, stderr io.Writer) int {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		fmt.Fprintln(stderr, "migrate: DATABASE_URL is not set")
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	pool, err := db.Open(ctx, url, 2, slog.New(slog.NewTextHandler(stderr, nil)))
	if err != nil {
		fmt.Fprintf(stderr, "migrate %s: %v\n", action, err)
		return 1
	}
	defer pool.Close()
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer sqlDB.Close()

	fn := map[string]func(context.Context, *sql.DB, io.Writer) error{
		"up": migrate.Up, "baseline": migrate.Baseline, "status": migrate.Status,
	}[action]
	if err := fn(ctx, sqlDB, stdout); err != nil {
		fmt.Fprintf(stderr, "migrate %s: %v\n", action, err)
		return 1
	}
	return 0
}

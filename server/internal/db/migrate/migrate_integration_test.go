//go:build integration

package migrate

import (
	"bytes"
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/habiibullahm/nibie-cloud/server/internal/db"
	"github.com/habiibullahm/nibie-cloud/server/internal/db/schemadump"
	"github.com/habiibullahm/nibie-cloud/server/internal/testutil/pgtest"
	"github.com/habiibullahm/nibie-cloud/server/migrations"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
)

func open(t *testing.T, url string) (context.Context, *pgxpool.Pool, *sql.DB) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	pool, err := db.Open(ctx, url, db.MaxConns, nil)
	if err != nil {
		t.Fatal(err)
	}
	sqlDB := stdlib.OpenDBFromPool(pool)
	t.Cleanup(func() { sqlDB.Close(); pool.Close() })
	return ctx, pool, sqlDB
}

func appliedVersions(ctx context.Context, t *testing.T, pool *pgxpool.Pool) []int64 {
	t.Helper()
	rows, err := pool.Query(ctx, `SELECT version_id FROM goose_db_version WHERE is_applied ORDER BY version_id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var v int64
		if err := rows.Scan(&v); err != nil {
			t.Fatal(err)
		}
		out = append(out, v)
	}
	return out
}

// simulatePrisma builds what Prisma Migrate leaves behind: the 16 migrations applied and a
// _prisma_migrations table that lists them, finished and not rolled back. No goose table.
func simulatePrisma(ctx context.Context, t *testing.T, pool *pgxpool.Pool, sqlDB *sql.DB) {
	t.Helper()
	p, err := migrations.NewProvider(sqlDB)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.UpTo(ctx, migrations.PrismaMigrations); err != nil {
		t.Fatal(err)
	}
	names, err := migrations.PrismaNames()
	if err != nil {
		t.Fatal(err)
	}
	stmts := []string{
		`DROP TABLE goose_db_version`,
		`CREATE TABLE "_prisma_migrations" (id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL, finished_at timestamptz,
			migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz, started_at timestamptz NOT NULL DEFAULT now(),
			applied_steps_count integer NOT NULL DEFAULT 0)`,
	}
	for _, s := range stmts {
		if _, err := pool.Exec(ctx, s); err != nil {
			t.Fatal(err)
		}
	}
	for _, n := range names {
		if _, err := pool.Exec(ctx, `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, applied_steps_count)
			VALUES (gen_random_uuid()::text, 'x', now(), $1, 1)`, n); err != nil {
			t.Fatal(err)
		}
	}
}

func TestUpFromEmpty(t *testing.T) {
	ctx, pool, sqlDB := open(t, pgtest.Fresh(t, ""))
	var out bytes.Buffer
	if err := Up(ctx, sqlDB, &out); err != nil {
		t.Fatal(err)
	}
	if got := appliedVersions(ctx, t, pool); len(got) != migrations.PrismaMigrations+2 || got[len(got)-1] != migrations.RiverVersion {
		t.Fatalf("applied versions = %v (0 plus 1..%d)", got, migrations.RiverVersion)
	}
	var river bool
	if err := pool.QueryRow(ctx, `SELECT to_regclass('river_job') IS NOT NULL`).Scan(&river); err != nil || !river {
		t.Fatalf("river_job missing (err %v)", err)
	}
	out.Reset()
	if err := Status(ctx, sqlDB, &out); err != nil {
		t.Fatal(err)
	}
	if int64(strings.Count(out.String(), "applied")) != migrations.RiverVersion || strings.Contains(out.String(), "pending") {
		t.Fatalf("status:\n%s", out.String())
	}
}

func TestBaselineThenUpSimulated(t *testing.T) {
	ctx, pool, sqlDB := open(t, pgtest.Fresh(t, ""))
	simulatePrisma(ctx, t, pool, sqlDB)
	baselineThenUp(ctx, t, pool, sqlDB)
}

// TestBaselineThenUpRealPrisma runs the same path on a database Prisma itself migrated (a template made with
// `pnpm db:migrate`, see testdata/golden/README.md). Skipped when HERMES_TEST_PRISMA_TEMPLATE is unset.
func TestBaselineThenUpRealPrisma(t *testing.T) {
	tpl := os.Getenv("HERMES_TEST_PRISMA_TEMPLATE")
	if tpl == "" {
		t.Skip("HERMES_TEST_PRISMA_TEMPLATE not set: no Prisma-migrated template database to copy")
	}
	ctx, pool, sqlDB := open(t, pgtest.Fresh(t, tpl))
	baselineThenUp(ctx, t, pool, sqlDB)
}

func baselineThenUp(ctx context.Context, t *testing.T, pool *pgxpool.Pool, sqlDB *sql.DB) {
	t.Helper()
	before, err := schemadump.Dump(ctx, pool, "public")
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := Baseline(ctx, sqlDB, &out); err != nil {
		t.Fatal(err)
	}
	if got := appliedVersions(ctx, t, pool); len(got) != migrations.PrismaMigrations+1 {
		t.Fatalf("after baseline: versions %v, want 0..%d", got, migrations.PrismaMigrations)
	}
	out.Reset()
	if err := Up(ctx, sqlDB, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "17") || strings.Contains(out.String(), "00001") {
		t.Fatalf("up after baseline must apply only the River migration:\n%s", out.String())
	}
	after, err := schemadump.Dump(ctx, pool, "public")
	if err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("baseline + up changed the application schema")
	}
}

// TestBaselineRefuses: anything but "exactly the 16 Prisma migrations, all finished, and no goose rows" is
// refused, with nothing changed (Review Focus 2).
func TestBaselineRefuses(t *testing.T) {
	names, err := migrations.PrismaNames()
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]string{
		"one missing":        `DELETE FROM "_prisma_migrations" WHERE migration_name = '` + names[3] + `'`,
		"one rolled back":    `UPDATE "_prisma_migrations" SET rolled_back_at = now() WHERE migration_name = '` + names[5] + `'`,
		"one unfinished":     `UPDATE "_prisma_migrations" SET finished_at = NULL WHERE migration_name = '` + names[15] + `'`,
		"an unknown row":     `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name) VALUES ('x', 'x', now(), '20991231000000_future')`,
		"goose already used": `CREATE TABLE goose_db_version (id serial PRIMARY KEY, version_id bigint NOT NULL, is_applied boolean NOT NULL, tstamp timestamp DEFAULT now()); INSERT INTO goose_db_version (version_id, is_applied) VALUES (0, true), (1, true)`,
		"no prisma table":    `DROP TABLE "_prisma_migrations"`,
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			ctx, pool, sqlDB := open(t, pgtest.Fresh(t, ""))
			simulatePrisma(ctx, t, pool, sqlDB)
			if _, err := pool.Exec(ctx, mutate); err != nil {
				t.Fatal(err)
			}
			snapshot := func() string {
				var s string
				err := pool.QueryRow(ctx, `SELECT
					COALESCE((SELECT string_agg(migration_name || coalesce(finished_at::text,'-') || coalesce(rolled_back_at::text,'-'), ',' ORDER BY migration_name) FROM "_prisma_migrations"), 'none')
					|| '|' || COALESCE((SELECT count(*)::text FROM goose_db_version), 'none')`).Scan(&s)
				if err != nil {
					// One of the two tables may not exist in this case; compare what exists.
					var p, g bool
					_ = pool.QueryRow(ctx, `SELECT to_regclass('"_prisma_migrations"') IS NOT NULL, to_regclass('goose_db_version') IS NOT NULL`).Scan(&p, &g)
					return "prisma=" + boolStr(p) + " goose=" + boolStr(g)
				}
				return s
			}
			before := snapshot()
			var out bytes.Buffer
			err := Baseline(ctx, sqlDB, &out)
			if err == nil || !strings.HasPrefix(err.Error(), "baseline refused: ") {
				t.Fatalf("want a refusal, got %v", err)
			}
			if after := snapshot(); after != before {
				t.Fatalf("baseline changed the database:\nbefore %s\nafter  %s", before, after)
			}
		})
	}
}

// TestBaselineAfterStatusOrFailedUp: `migrate status` (or a mistaken `migrate up`, which fails on 00001
// and rolls back) creates goose_db_version with only goose's version-0 row. Baseline must still work.
func TestBaselineAfterStatusOrFailedUp(t *testing.T) {
	for _, first := range []string{"status", "failed up"} {
		t.Run(first, func(t *testing.T) {
			ctx, pool, sqlDB := open(t, pgtest.Fresh(t, ""))
			simulatePrisma(ctx, t, pool, sqlDB)
			var out bytes.Buffer
			if first == "status" {
				if err := Status(ctx, sqlDB, &out); err != nil {
					t.Fatal(err)
				}
			} else if err := Up(ctx, sqlDB, &out); err == nil {
				t.Fatal("up on a Prisma-built database must fail (its tables already exist)")
			}
			if err := Baseline(ctx, sqlDB, &out); err != nil {
				t.Fatalf("baseline after %s: %v", first, err)
			}
			if got := appliedVersions(ctx, t, pool); len(got) != migrations.PrismaMigrations+1 {
				t.Fatalf("after baseline: versions %v, want 0..%d once each", got, migrations.PrismaMigrations)
			}
			out.Reset()
			if err := Up(ctx, sqlDB, &out); err != nil || !strings.Contains(out.String(), "00017") {
				t.Fatalf("up after baseline: %v\n%s", err, out.String())
			}
		})
	}
}

func TestBaselineTwice(t *testing.T) {
	ctx, pool, sqlDB := open(t, pgtest.Fresh(t, ""))
	simulatePrisma(ctx, t, pool, sqlDB)
	var out bytes.Buffer
	if err := Baseline(ctx, sqlDB, &out); err != nil {
		t.Fatal(err)
	}
	if err := Baseline(ctx, sqlDB, &out); err == nil || !strings.Contains(err.Error(), "goose_db_version") {
		t.Fatalf("second baseline: want a refusal naming goose_db_version, got %v", err)
	}
}

func boolStr(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

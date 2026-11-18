//go:build integration

package schemadump

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/habiibullahm/nibie-cloud/server/internal/db"
	"github.com/habiibullahm/nibie-cloud/server/internal/testutil/pgtest"
	"github.com/habiibullahm/nibie-cloud/server/migrations"
	"github.com/jackc/pgx/v5/stdlib"
)

// PrismaMigrations is the number of Prisma migrations the goose files copy (spec section 3).
const PrismaMigrations = 16

func golden(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "testdata", "golden", "schema.txt"))
	if err != nil {
		t.Fatal(err)
	}
	return strings.ReplaceAll(string(b), "\r\n", "\n")
}

// TestGooseSchemaMatchesPrisma: the goose copies of the Prisma migrations build exactly the schema Prisma
// built (testdata/golden/schema.txt was dumped from a Prisma-migrated database).
func TestGooseSchemaMatchesPrisma(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	url := pgtest.Fresh(t, "")
	pool, err := db.Open(ctx, url, db.MaxConns, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer sqlDB.Close()
	applyPrismaCopies(ctx, t, sqlDB)

	got, err := Dump(ctx, pool, "public")
	if err != nil {
		t.Fatal(err)
	}
	if want := golden(t); got != want {
		t.Fatalf("schema differs from the Prisma golden:\n%s", lineDiff(want, got))
	}
}

// TestDumpSeesDifferences: Dump is not blind. One extra index makes it differ from the golden.
func TestDumpSeesDifferences(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	url := pgtest.Fresh(t, "")
	pool, err := db.Open(ctx, url, db.MaxConns, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer sqlDB.Close()
	applyPrismaCopies(ctx, t, sqlDB)
	if _, err := pool.Exec(ctx, `CREATE INDEX extra_idx ON "Instance" ("name")`); err != nil {
		t.Fatal(err)
	}
	got, err := Dump(ctx, pool, "public")
	if err != nil {
		t.Fatal(err)
	}
	if got == golden(t) || !strings.Contains(got, "extra_idx") {
		t.Fatal("Dump did not notice an extra index")
	}
}

func applyPrismaCopies(ctx context.Context, t *testing.T, sqlDB *sql.DB) {
	t.Helper()
	p, err := migrations.NewProvider(sqlDB)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.UpTo(ctx, PrismaMigrations); err != nil {
		t.Fatal(err)
	}
}

func lineDiff(want, got string) string {
	w, g := strings.Split(want, "\n"), strings.Split(got, "\n")
	inW, inG := map[string]bool{}, map[string]bool{}
	for _, l := range w {
		inW[l] = true
	}
	for _, l := range g {
		inG[l] = true
	}
	var b strings.Builder
	for _, l := range w {
		if !inG[l] {
			b.WriteString("- " + l + "\n")
		}
	}
	for _, l := range g {
		if !inW[l] {
			b.WriteString("+ " + l + "\n")
		}
	}
	return b.String()
}

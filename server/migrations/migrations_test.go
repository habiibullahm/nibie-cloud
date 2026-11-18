package migrations

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/riverqueue/river/riverdriver/riverdatabasesql"
	"github.com/riverqueue/river/rivermigrate"
)

// TestPrismaNames: every goose copy names its Prisma source, in order, and there is one per Prisma migration.
func TestPrismaNames(t *testing.T) {
	names, err := PrismaNames()
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != PrismaMigrations {
		t.Fatalf("got %d names, want %d", len(names), PrismaMigrations)
	}
	if !slices.IsSorted(names) {
		t.Fatalf("names are not in order: %v", names)
	}
	if names[0] != "20261111144544_init" || names[len(names)-1] != "20261119100000_add_admin_api_key" {
		t.Fatalf("first/last = %s / %s", names[0], names[len(names)-1])
	}
	// The repository's Prisma folder (still present until milestone M9) has exactly these migrations.
	entries, err := os.ReadDir(filepath.Join("..", "..", "prisma", "migrations"))
	if err != nil {
		t.Skipf("prisma/migrations not readable: %v", err)
	}
	var dirs []string
	for _, e := range entries {
		if e.IsDir() {
			dirs = append(dirs, e.Name())
		}
	}
	if !slices.Equal(dirs, names) {
		t.Fatalf("prisma/migrations has %v, goose copies name %v", dirs, names)
	}
}

// TestRiverTargetIsLatest: upgrading River without deciding on its new migrations fails here.
func TestRiverTargetIsLatest(t *testing.T) {
	m, err := rivermigrate.New(riverdatabasesql.New(nil), nil)
	if err != nil {
		t.Fatal(err)
	}
	all := m.AllVersions()
	if latest := all[len(all)-1].Version; latest != RiverMigrationTarget {
		t.Fatalf("River ships migrations up to %d, RiverMigrationTarget is %d", latest, RiverMigrationTarget)
	}
}

package db

import (
	"path/filepath"
	"strings"
	"testing"
)

// TestUpdatesSetUpdatedAt: Prisma filled "updatedAt" on every update by itself (@updatedAt). Without
// Prisma, every UPDATE of a table that has the column must set it (spec section 3).
func TestUpdatesSetUpdatedAt(t *testing.T) {
	tables, err := TablesWithColumn(filepath.Join("..", "..", "testdata", "golden", "schema.txt"), "updatedAt")
	if err != nil {
		t.Fatal(err)
	}
	if len(tables) == 0 {
		t.Fatal("no table with an updatedAt column found in the schema golden")
	}
	if bad, err := UpdatesMissingColumn(filepath.Join("queries"), tables, "updatedAt"); err != nil {
		t.Fatal(err)
	} else if len(bad) > 0 {
		t.Fatalf("UPDATE without \"updatedAt\": %s", strings.Join(bad, "; "))
	}
	// The check can fail: a deliberately bad query file is caught.
	bad, err := UpdatesMissingColumn(filepath.Join("testdata", "queries-bad"), tables, "updatedAt")
	if err != nil {
		t.Fatal(err)
	}
	if len(bad) != 1 || !strings.Contains(bad[0], "TouchInstance") {
		t.Fatalf("bad fixture: got %v, want exactly TouchInstance", bad)
	}
}

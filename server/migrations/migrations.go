// Package migrations holds the database schema as goose migrations, embedded in the binary.
//
//   - 00001–000NN are verbatim copies of prisma/migrations (one file per Prisma migration, in order), so a
//     database built by goose is identical to one built by Prisma (checked against testdata/golden/schema.txt).
//   - version PrismaMigrations+1 adds River's job queue tables (river.go, a Go migration).
//
// Never edit a migration that has run in production; add a new one.
package migrations

import (
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"regexp"
	"slices"

	"github.com/pressly/goose/v3"
)

//go:embed *.sql
var FS embed.FS

// PrismaMigrations is how many Prisma migrations the goose files copy (TestPrismaNames checks it against
// prisma/migrations).
const PrismaMigrations = 17

// NewProvider returns a goose provider over the embedded SQL migrations plus the River migration, recording
// versions in goose_db_version in the connection's search_path schema.
func NewProvider(db *sql.DB) (*goose.Provider, error) {
	return goose.NewProvider(goose.DialectPostgres, db, FS, goose.WithGoMigrations(riverMigration()))
}

var copiedFrom = regexp.MustCompile(`prisma/migrations/([0-9]{14}_[a-z0-9_]+)/migration\.sql`)

// PrismaNames returns the Prisma migration names (`<timestamp>_<name>`) the goose copies came from, in
// order. `migrate baseline` requires exactly these in _prisma_migrations.
func PrismaNames() ([]string, error) {
	files, err := fs.Glob(FS, "*.sql")
	if err != nil {
		return nil, err
	}
	slices.Sort(files)
	var names []string
	for _, f := range files {
		b, err := FS.ReadFile(f)
		if err != nil {
			return nil, err
		}
		m := copiedFrom.FindSubmatch(b)
		if m == nil {
			return nil, fmt.Errorf("%s does not name its Prisma source", f)
		}
		names = append(names, string(m[1]))
	}
	return names, nil
}

// Package migrations holds the database schema as goose migrations, embedded in the binary.
//
// 00001–00016 are verbatim copies of prisma/migrations (one file per Prisma migration, in order), so a
// database built by goose is identical to one built by Prisma (checked against testdata/golden/schema.txt).
// Never edit a migration that has run in production; add a new one.
package migrations

import (
	"database/sql"
	"embed"

	"github.com/pressly/goose/v3"
)

//go:embed *.sql
var FS embed.FS

// NewProvider returns a goose provider over the embedded migrations, recording versions in goose_db_version
// in the connection's search_path schema.
func NewProvider(db *sql.DB) (*goose.Provider, error) {
	return goose.NewProvider(goose.DialectPostgres, db, FS)
}

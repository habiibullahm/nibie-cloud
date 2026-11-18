// Package migrate runs the schema migrations (`hermes-cloud migrate up|status|baseline`).
package migrate

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"path"
	"slices"

	"github.com/habiibullahm/nibie-cloud/server/migrations"
	"github.com/pressly/goose/v3/database"
)

const gooseTable = "goose_db_version"

// Up applies every pending migration and prints one line per applied version.
func Up(ctx context.Context, db *sql.DB, w io.Writer) error {
	p, err := migrations.NewProvider(db)
	if err != nil {
		return err
	}
	res, err := p.Up(ctx)
	if err != nil {
		return err
	}
	if len(res) == 0 {
		fmt.Fprintln(w, "migrate: nothing to apply")
	}
	for _, r := range res {
		fmt.Fprintf(w, "migrate: applied %05d %s (%s)\n", r.Source.Version, label(r.Source.Path), r.Duration.Round(1e6))
	}
	return nil
}

// Status prints every migration as applied or pending.
func Status(ctx context.Context, db *sql.DB, w io.Writer) error {
	p, err := migrations.NewProvider(db)
	if err != nil {
		return err
	}
	all, err := p.Status(ctx)
	if err != nil {
		return err
	}
	for _, s := range all {
		fmt.Fprintf(w, "%-7s %05d %s\n", s.State, s.Source.Version, label(s.Source.Path))
	}
	return nil
}

func label(p string) string {
	if p == "" {
		return "river (Go migration)"
	}
	return path.Base(p)
}

// Baseline adopts a database that Prisma Migrate built: it records goose versions 0–16 as applied without
// running them, so `up` then applies only what came after Prisma (River). It runs in one transaction and
// refuses, changing nothing, unless _prisma_migrations lists exactly the 16 expected migrations, each
// finished and none rolled back, and goose_db_version is absent or empty.
func Baseline(ctx context.Context, db *sql.DB, w io.Writer) error {
	want, err := migrations.PrismaNames()
	if err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	var prismaTable, gooseExists bool
	if err := tx.QueryRowContext(ctx, `SELECT to_regclass('"_prisma_migrations"') IS NOT NULL, to_regclass($1) IS NOT NULL`, gooseTable).Scan(&prismaTable, &gooseExists); err != nil {
		return err
	}
	if !prismaTable {
		return refused("_prisma_migrations does not exist (this database was not built by Prisma)")
	}
	rows, err := tx.QueryContext(ctx, `SELECT migration_name, finished_at IS NOT NULL, rolled_back_at IS NULL FROM "_prisma_migrations" ORDER BY migration_name`)
	if err != nil {
		return err
	}
	var got []string
	allDone := true
	for rows.Next() {
		var name string
		var finished, notRolledBack bool
		if err := rows.Scan(&name, &finished, &notRolledBack); err != nil {
			rows.Close()
			return err
		}
		got = append(got, name)
		allDone = allDone && finished && notRolledBack
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if !slices.Equal(got, want) {
		return refused(fmt.Sprintf("_prisma_migrations lists %d migrations, not exactly the %d expected ones", len(got), len(want)))
	}
	if !allDone {
		return refused("_prisma_migrations has an unfinished or rolled-back migration")
	}
	if gooseExists {
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM `+gooseTable).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			return refused(gooseTable + " already has rows (baseline already ran, or goose was used here)")
		}
	}

	store, err := database.NewStore(database.DialectPostgres, gooseTable)
	if err != nil {
		return err
	}
	if !gooseExists {
		if err := store.CreateVersionTable(ctx, tx); err != nil {
			return err
		}
	}
	for v := int64(0); v <= migrations.PrismaMigrations; v++ {
		if err := store.Insert(ctx, tx, database.InsertRequest{Version: v}); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	fmt.Fprintf(w, "migrate: baseline recorded versions 1-%d as applied (Prisma migrations); run `migrate up` next\n", migrations.PrismaMigrations)
	return nil
}

func refused(why string) error { return errors.New("baseline refused: " + why) }

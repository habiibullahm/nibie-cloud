package migrations

import (
	"context"
	"database/sql"
	"log/slog"

	"github.com/pressly/goose/v3"
	"github.com/riverqueue/river/riverdriver/riverdatabasesql"
	"github.com/riverqueue/river/rivermigrate"
)

// RiverVersion is the goose version that installs River's tables.
const RiverVersion int64 = 17

// RiverMigrationTarget is the River schema version this migration installs: the latest one shipped by the
// River release pinned in go.mod. A River upgrade that adds migrations fails TestRiverTargetIsLatest
// until a new goose migration takes River to the new version.
const RiverMigrationTarget = 8

// riverMigration runs River's own migrator outside a goose transaction: River applies each of its versions
// in a transaction of its own, which it must (its version 6 adds an enum value and then uses it, and
// Postgres refuses that inside one transaction). River records its progress in river_migration, so a run
// that stops halfway resumes where it stopped.
func riverMigration() *goose.Migration {
	return goose.NewGoMigration(RiverVersion,
		&goose.GoFunc{Mode: goose.TransactionDisabled, RunDB: func(ctx context.Context, db *sql.DB) error {
			return migrateRiver(ctx, db, rivermigrate.DirectionUp, RiverMigrationTarget)
		}},
		&goose.GoFunc{Mode: goose.TransactionDisabled, RunDB: func(ctx context.Context, db *sql.DB) error {
			return migrateRiver(ctx, db, rivermigrate.DirectionDown, -1)
		}},
	)
}

func migrateRiver(ctx context.Context, db *sql.DB, dir rivermigrate.Direction, target int) error {
	m, err := rivermigrate.New(riverdatabasesql.New(db), &rivermigrate.Config{Logger: slog.New(slog.DiscardHandler)})
	if err != nil {
		return err
	}
	_, err = m.Migrate(ctx, dir, &rivermigrate.MigrateOpts{TargetVersion: target})
	return err
}

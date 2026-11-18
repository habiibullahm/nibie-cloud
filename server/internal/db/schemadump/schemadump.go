// Package schemadump prints a database schema as deterministic text, so two databases built different ways
// (Prisma then, goose now) can be compared line by line.
package schemadump

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// excluded reports whether a table belongs to a migration tool or the job queue, not to the application.
func excluded(table string) bool {
	return table == "_prisma_migrations" || table == "goose_db_version" || strings.HasPrefix(table, "river_")
}

// Dump describes the application schema (River's tables, enums and sequences and the migration tools'
// tables are left out): enums (labels in order), sequences, then per table its row-level security
// flags, columns (in column order), constraints, indexes and policies. The schema name is removed from
// index definitions so a dump of one schema compares with a dump of another.
func Dump(ctx context.Context, pool *pgxpool.Pool, schema string) (string, error) {
	var b strings.Builder

	rows, err := pool.Query(ctx, `
		SELECT t.typname, string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder)
		FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace
		WHERE n.nspname = $1 AND t.typname NOT LIKE 'river\_%' GROUP BY t.typname ORDER BY t.typname`, schema)
	if err != nil {
		return "", err
	}
	for rows.Next() {
		var name, labels string
		if err := rows.Scan(&name, &labels); err != nil {
			return "", err
		}
		fmt.Fprintf(&b, "enum %s: %s\n", name, labels)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}

	var seqs []string
	rows, err = pool.Query(ctx, `
		SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = $1 AND c.relkind = 'S' ORDER BY c.relname`, schema)
	if err != nil {
		return "", err
	}
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return "", err
		}
		if !strings.HasPrefix(s, "goose_db_version") && !strings.HasPrefix(s, "river_") {
			seqs = append(seqs, s)
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	for _, s := range seqs {
		fmt.Fprintf(&b, "sequence %s\n", s)
	}

	type table struct {
		oid        uint32
		name       string
		rls, force bool
	}
	var tables []table
	rows, err = pool.Query(ctx, `
		SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
		FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') ORDER BY c.relname`, schema)
	if err != nil {
		return "", err
	}
	for rows.Next() {
		var t table
		if err := rows.Scan(&t.oid, &t.name, &t.rls, &t.force); err != nil {
			return "", err
		}
		if !excluded(t.name) {
			tables = append(tables, t)
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}

	for _, t := range tables {
		fmt.Fprintf(&b, "table %s rls=%t force_rls=%t\n", t.name, t.rls, t.force)
		lines, err := collect(ctx, pool, `
			SELECT format('column %s %s%s%s', a.attname, format_type(a.atttypid, a.atttypmod),
				CASE WHEN a.attnotnull THEN ' not null' ELSE '' END,
				COALESCE(' default ' || pg_get_expr(d.adbin, d.adrelid), ''))
			FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
			WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, t.oid)
		if err != nil {
			return "", err
		}
		more, err := collect(ctx, pool, `
			SELECT format('constraint %s %s', conname, pg_get_constraintdef(oid))
			FROM pg_constraint WHERE conrelid = $1 ORDER BY conname`, t.oid)
		if err != nil {
			return "", err
		}
		lines = append(lines, more...)
		idx, err := collect(ctx, pool, `
			SELECT format('index %s', pg_get_indexdef(indexrelid)) FROM pg_index WHERE indrelid = $1`, t.oid)
		if err != nil {
			return "", err
		}
		for i := range idx {
			idx[i] = strings.ReplaceAll(idx[i], " ON "+schema+".", " ON ")
		}
		slices.Sort(idx)
		lines = append(lines, idx...)
		pol, err := collect(ctx, pool, `
			SELECT format('policy %s %s %s using=%s check=%s', polname, polcmd, polpermissive,
				COALESCE(pg_get_expr(polqual, polrelid), '-'), COALESCE(pg_get_expr(polwithcheck, polrelid), '-'))
			FROM pg_policy WHERE polrelid = $1 ORDER BY polname`, t.oid)
		if err != nil {
			return "", err
		}
		lines = append(lines, pol...)
		for _, l := range lines {
			b.WriteString("  " + l + "\n")
		}
	}
	return b.String(), nil
}

func collect(ctx context.Context, pool *pgxpool.Pool, query string, arg uint32) ([]string, error) {
	rows, err := pool.Query(ctx, query, arg)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

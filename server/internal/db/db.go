// Package db opens the backend's Postgres pool. It reads the same DATABASE_URL the Node backend (Prisma)
// used, so the production env file does not change.
package db

import (
	"context"
	"errors"
	"log/slog"
	"net/url"
	"slices"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// MaxConns is the pool size. The API and River share one pool; River's LISTEN connection counts against
// it, and so does the per-client limit of Supabase's session pooler.
const MaxConns int32 = 10

// prismaParams are query parameters Prisma understood and Postgres does not. Passed through, pgx would
// send them as startup parameters and the server would refuse the connection.
var prismaParams = []string{"connection_limit", "pgbouncer", "pool_timeout", "schema", "socket_timeout", "sslaccept", "statement_cache_size"}

var errBadURL = errors.New("DATABASE_URL is not a valid postgres:// or postgresql:// URL")

// splitPrismaParams removes Prisma's parameters from a URL and returns the cleaned URL, the schema named
// by ?schema= (or ""), and the removed parameter names, sorted. Errors never include the input.
func splitPrismaParams(raw string) (clean, schema string, stripped []string, err error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		return "", "", nil, errBadURL
	}
	q := u.Query()
	schema = q.Get("schema")
	for _, k := range prismaParams {
		if q.Has(k) {
			stripped = append(stripped, k)
			q.Del(k)
		}
	}
	slices.Sort(stripped)
	u.RawQuery = q.Encode()
	return u.String(), schema, stripped, nil
}

func searchPathSQL(schema string) string {
	return "SET search_path TO " + pgx.Identifier{schema}.Sanitize()
}

// ParseURL turns a (possibly Prisma-style) DATABASE_URL into a pool config. ?schema=X becomes
// `SET search_path TO "X"` on every new connection: a statement works behind any pooler, where a startup
// parameter may be refused. It returns the names of the Prisma parameters it removed.
func ParseURL(databaseURL string) (*pgxpool.Config, []string, error) {
	clean, schema, stripped, err := splitPrismaParams(databaseURL)
	if err != nil {
		return nil, nil, err
	}
	cfg, err := pgxpool.ParseConfig(clean)
	if err != nil {
		return nil, nil, errBadURL
	}
	if schema != "" {
		stmt := searchPathSQL(schema)
		cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
			_, err := c.Exec(ctx, stmt)
			return err
		}
	}
	return cfg, stripped, nil
}

// Open creates the pool and checks it with one ping. It logs the names (never the values) of the Prisma
// parameters it ignored. Errors do not carry the URL or the password.
func Open(ctx context.Context, databaseURL string, maxConns int32, log *slog.Logger) (*pgxpool.Pool, error) {
	cfg, stripped, err := ParseURL(databaseURL)
	if err != nil {
		return nil, err
	}
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	if len(stripped) > 0 {
		log.Info("db: ignored Prisma parameters", "params", stripped)
	}
	cfg.MaxConns = maxConns
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, errors.New("db: cannot create the connection pool")
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, errors.New("db: cannot reach the database")
	}
	return pool, nil
}

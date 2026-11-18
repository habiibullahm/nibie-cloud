package db

import (
	"slices"
	"strings"
	"testing"
)

func TestParseURL(t *testing.T) {
	const pre = "postgresql://u:p@127.0.0.1:5433/db"
	tests := []struct {
		name       string
		in         string
		wantSchema string
		stripped   []string
	}{
		{"schema only", pre + "?schema=hermes", "hermes", []string{"schema"}},
		{"prisma params and sslmode", pre + "?schema=hermes&pgbouncer=true&connection_limit=1&sslmode=disable", "hermes", []string{"connection_limit", "pgbouncer", "schema"}},
		{"all prisma params", pre + "?pool_timeout=10&socket_timeout=5&statement_cache_size=0&sslaccept=strict", "", []string{"pool_timeout", "socket_timeout", "sslaccept", "statement_cache_size"}},
		{"plain", pre, "", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, schema, stripped, err := splitPrismaParams(tt.in)
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(stripped, tt.stripped) {
				t.Fatalf("stripped = %v, want %v", stripped, tt.stripped)
			}
			if schema != tt.wantSchema {
				t.Fatalf("schema = %q, want %q", schema, tt.wantSchema)
			}
			cfg, stripped2, err := ParseURL(tt.in)
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(stripped2, tt.stripped) {
				t.Fatalf("ParseURL stripped = %v, want %v", stripped2, tt.stripped)
			}
			if (cfg.AfterConnect != nil) != (tt.wantSchema != "") {
				t.Fatalf("AfterConnect set = %v, want %v", cfg.AfterConnect != nil, tt.wantSchema != "")
			}
			for _, k := range []string{"schema", "pgbouncer", "connection_limit", "pool_timeout", "socket_timeout", "statement_cache_size", "sslaccept"} {
				if _, ok := cfg.ConnConfig.RuntimeParams[k]; ok {
					t.Fatalf("Prisma parameter %s reached the server's runtime params", k)
				}
			}
		})
	}
}

func TestParseURLDecodesPassword(t *testing.T) {
	cfg, _, err := ParseURL("postgresql://u:p%40ss@127.0.0.1:5433/db?schema=hermes")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Password != "p@ss" || cfg.ConnConfig.User != "u" || cfg.ConnConfig.Database != "db" {
		t.Fatalf("user/password/database = %q/%q/%q", cfg.ConnConfig.User, cfg.ConnConfig.Password, cfg.ConnConfig.Database)
	}
}

func TestParseURLErrorHidesInput(t *testing.T) {
	for _, in := range []string{"not a url with secret-pw", "postgresql://u:secret-pw@host:notaport/db", "mysql://u:secret-pw@host/db"} {
		_, _, err := ParseURL(in)
		if err == nil {
			t.Fatalf("%q: want an error", in)
		}
		if strings.Contains(err.Error(), "secret-pw") || strings.Contains(err.Error(), "host") {
			t.Fatalf("error leaks the input: %v", err)
		}
	}
}

func TestSearchPathStatementQuotesTheSchema(t *testing.T) {
	if got := searchPathSQL(`we"ird; DROP`); got != `SET search_path TO "we""ird; DROP"` {
		t.Fatalf("statement = %s", got)
	}
}

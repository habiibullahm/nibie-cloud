// Command schemadump prints a database schema as deterministic text (internal/db/schemadump). It makes
// testdata/golden/schema.txt from a Prisma-migrated database; see testdata/golden/README.md.
//
//	schemadump -url postgresql://... -schema public
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/habiibullahm/nibie-cloud/server/internal/db"
	"github.com/habiibullahm/nibie-cloud/server/internal/db/schemadump"
)

func main() {
	url := flag.String("url", "", "database URL")
	schema := flag.String("schema", "public", "schema to describe")
	flag.Parse()
	if *url == "" {
		fmt.Fprintln(os.Stderr, "usage: schemadump -url <database URL> [-schema public]")
		os.Exit(2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool, err := db.Open(ctx, *url, 2, slog.New(slog.DiscardHandler))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer pool.Close()
	out, err := schemadump.Dump(ctx, pool, *schema)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Print(out)
}

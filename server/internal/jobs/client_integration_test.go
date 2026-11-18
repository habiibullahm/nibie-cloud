//go:build integration

package jobs

import (
	"context"
	"io"
	"testing"
	"time"

	"github.com/habiibullahm/nibie-cloud/server/internal/db"
	"github.com/habiibullahm/nibie-cloud/server/internal/db/migrate"
	"github.com/habiibullahm/nibie-cloud/server/internal/testutil/pgtest"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/riverqueue/river"
)

type noopArgs struct{}

func (noopArgs) Kind() string { return "m0_noop" }

type noopWorker struct {
	river.WorkerDefaults[noopArgs]
	done chan struct{}
}

func (w *noopWorker) Work(context.Context, *river.Job[noopArgs]) error {
	close(w.done)
	return nil
}

// TestRiverRunsJob: River starts on the migrated schema and runs a job, with LISTEN/NOTIFY and in
// poll-only mode (the fallback for poolers that do not pass notifications).
func TestRiverRunsJob(t *testing.T) {
	for _, pollOnly := range []bool{false, true} {
		name := "listen"
		if pollOnly {
			name = "poll-only"
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			pool, err := db.Open(ctx, pgtest.Fresh(t, "")+"?schema=public", db.MaxConns, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer pool.Close()
			sqlDB := stdlib.OpenDBFromPool(pool)
			defer sqlDB.Close()
			if err := migrate.Up(ctx, sqlDB, io.Discard); err != nil {
				t.Fatal(err)
			}

			w := &noopWorker{done: make(chan struct{})}
			workers := river.NewWorkers()
			river.AddWorker(workers, w)
			client, err := NewClient(pool, workers, pollOnly)
			if err != nil {
				t.Fatal(err)
			}
			if err := client.Start(ctx); err != nil {
				t.Fatal(err)
			}
			defer func() { _ = client.Stop(context.Background()) }()

			res, err := client.Insert(ctx, noopArgs{}, nil)
			if err != nil {
				t.Fatal(err)
			}
			select {
			case <-w.done:
			case <-time.After(10 * time.Second):
				t.Fatal("job not worked within 10 s")
			}
			deadline := time.Now().Add(10 * time.Second)
			for {
				var state string
				if err := pool.QueryRow(ctx, `SELECT state FROM river_job WHERE id = $1`, res.Job.ID).Scan(&state); err != nil {
					t.Fatal(err)
				}
				if state == "completed" {
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("job state = %s, want completed", state)
				}
				time.Sleep(100 * time.Millisecond)
			}
		})
	}
}

// Package jobs runs background work on River, a job queue stored in the same Postgres database
// (spec section 3: it replaces BullMQ and Redis).
package jobs

import (
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
)

// MaxAttempts matches the Node queue: the first try plus 4 retries with backoff.
const MaxAttempts = 5

// NewClient returns a River client on pool. With workers it also works the default queue (2 at a time);
// without, it can only insert jobs. pollOnly avoids LISTEN/NOTIFY, for poolers that do not pass them.
func NewClient(pool *pgxpool.Pool, workers *river.Workers, pollOnly bool) (*river.Client[pgx.Tx], error) {
	cfg := &river.Config{MaxAttempts: MaxAttempts, PollOnly: pollOnly}
	if workers != nil {
		cfg.Workers = workers
		cfg.Queues = map[string]river.QueueConfig{river.QueueDefault: {MaxWorkers: 2}}
	}
	return river.NewClient(riverpgxv5.New(pool), cfg)
}

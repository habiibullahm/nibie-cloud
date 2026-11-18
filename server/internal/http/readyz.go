// Package http holds the backend's HTTP surface. In M0 that is only /healthz and /readyz; the operator,
// customer and admin APIs follow in later milestones.
package http

import (
	"context"
	"encoding/json"
	nethttp "net/http"
	"sync"
	"time"
)

// Check is one named dependency check for /readyz. It returns nil when the dependency answers.
type Check struct {
	Name string
	Fn   func(context.Context) error
}

// ReadyzTimeout is how long one check may take before it counts as failed.
const ReadyzTimeout = 3 * time.Second

// Readyz answers 200 {"status":"ok"} when every check passes, else 503 {"status":"fail","failed":[names]}
// in the order given. It runs the checks in parallel; a check that does not answer within timeout counts
// as failed even if it ignores its context. The body carries names only, never an error message.
// Port of src/http/readyz.ts. Meant for the host watchdog on loopback; the public proxy does not forward it.
func Readyz(checks []Check, timeout time.Duration) nethttp.HandlerFunc {
	return func(w nethttp.ResponseWriter, r *nethttp.Request) {
		failed := make([]bool, len(checks))
		var wg sync.WaitGroup
		for i, c := range checks {
			wg.Add(1)
			go func() {
				defer wg.Done()
				ctx, cancel := context.WithTimeout(r.Context(), timeout)
				defer cancel()
				done := make(chan error, 1)
				go func() { done <- c.Fn(ctx) }()
				select {
				case err := <-done:
					failed[i] = err != nil
				case <-ctx.Done():
					failed[i] = true
				}
			}()
		}
		wg.Wait()
		var names []string
		for i, f := range failed {
			if f {
				names = append(names, checks[i].Name)
			}
		}
		w.Header().Set("cache-control", "no-store")
		if len(names) == 0 {
			writeJSON(w, nethttp.StatusOK, statusBody{Status: "ok"})
			return
		}
		writeJSON(w, nethttp.StatusServiceUnavailable, statusBody{Status: "fail", Failed: names})
	}
}

// statusBody keeps Node's key order: "status" first.
type statusBody struct {
	Status string   `json:"status"`
	Failed []string `json:"failed,omitempty"`
}

func writeJSON(w nethttp.ResponseWriter, status int, body any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

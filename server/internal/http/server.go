package http

import (
	"log/slog"
	nethttp "net/http"
	"time"

	"github.com/habiibullahm/nibie-cloud/server/internal/shared/logger"
)

// Deps is what the handler needs.
type Deps struct {
	Log    *slog.Logger
	Checks []Check
}

// NewHandler returns the router: GET /healthz (process alive), GET /readyz (dependencies answer), and one
// log line per request (path without query string, client network only).
func NewHandler(d Deps) nethttp.Handler {
	mux := nethttp.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w nethttp.ResponseWriter, _ *nethttp.Request) {
		writeJSON(w, nethttp.StatusOK, statusBody{Status: "ok"})
	})
	mux.Handle("GET /readyz", Readyz(d.Checks, ReadyzTimeout))
	return logRequests(d.Log, mux)
}

type statusRecorder struct {
	nethttp.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func logRequests(log *slog.Logger, next nethttp.Handler) nethttp.Handler {
	return nethttp.HandlerFunc(func(w nethttp.ResponseWriter, r *nethttp.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: nethttp.StatusOK}
		next.ServeHTTP(rec, r)
		log.Info("request", logger.RequestAttr(r), "status", rec.status, "ms", time.Since(start).Milliseconds())
	})
}

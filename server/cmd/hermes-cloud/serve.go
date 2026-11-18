package main

import (
	"context"
	"errors"
	"io"
	"net"
	nethttp "net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/habiibullahm/nibie-cloud/server/internal/config"
	"github.com/habiibullahm/nibie-cloud/server/internal/db"
	"github.com/habiibullahm/nibie-cloud/server/internal/db/sqlcgen"
	apihttp "github.com/habiibullahm/nibie-cloud/server/internal/http"
	"github.com/habiibullahm/nibie-cloud/server/internal/shared/logger"
)

// shutdownLimit is how long a graceful stop may take before the process exits anyway (a stuck request,
// a dead database), like the Node backend's 30 s timer.
const shutdownLimit = 30 * time.Second

// serve runs the API on 127.0.0.1:PORT until SIGINT or SIGTERM. In M0 it only answers /healthz and
// /readyz; the Docker check, the job worker and the APIs come in later milestones.
func serve(ctx context.Context, cfg config.Config, stdout io.Writer) int {
	log := logger.New(stdout, logger.ParseLevel(os.Getenv("LOG_LEVEL")))
	log.Info("config", "config", cfg)
	if cfg.RedisURLIgnored {
		log.Warn("REDIS_URL is set but ignored: the Go backend keeps its job queue in Postgres")
	}

	pool, err := db.Open(ctx, cfg.DatabaseURL, db.MaxConns, log)
	if err != nil {
		log.Error("startup failed", "err", err.Error())
		return 1
	}
	defer pool.Close()
	queries := sqlcgen.New(pool)

	handler := apihttp.NewHandler(apihttp.Deps{Log: log, Checks: []apihttp.Check{
		{Name: "database", Fn: func(ctx context.Context) error { _, err := queries.Ping(ctx); return err }},
	}})
	// Loopback only: this API must not be reachable from the network (a proxy forwards what is public).
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.Port)))
	if err != nil {
		log.Error("listen failed", "err", err.Error())
		return 1
	}
	srv := &nethttp.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()
	log.Info("listening", "addr", ln.Addr().String())

	stop, cancel := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer cancel()
	select {
	case <-stop.Done():
	case err := <-served:
		log.Error("server stopped", "err", err.Error())
		return 1
	}

	log.Info("shutting down")
	hardStop := time.AfterFunc(shutdownLimit, func() {
		log.Error("shutdown took too long, exiting")
		os.Exit(1)
	})
	defer hardStop.Stop()
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), shutdownLimit)
	defer cancelShutdown()
	if err := srv.Shutdown(shutdownCtx); err != nil && !errors.Is(err, nethttp.ErrServerClosed) {
		log.Error("shutdown", "err", err.Error())
		return 1
	}
	return 0
}

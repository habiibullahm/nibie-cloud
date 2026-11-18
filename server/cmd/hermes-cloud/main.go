// Command hermes-cloud is the Hermes Cloud control plane: the HTTP APIs, the job worker and the
// migration tool, in one binary.
package main

import (
	"context"
	"fmt"
	"io"
	"os"

	"github.com/habiibullahm/nibie-cloud/server/internal/config"
)

const usage = "usage: hermes-cloud [serve|migrate up|migrate baseline|migrate status|healthcheck]"

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// run dispatches a subcommand and returns the process exit code: 0 success, 1 failure, 2 bad usage.
func run(args []string, stdout, stderr io.Writer) int {
	cmd := "serve"
	if len(args) > 0 {
		cmd = args[0]
	}
	switch cmd {
	case "serve":
		cfg, err := config.FromEnviron()
		if err != nil {
			fmt.Fprintf(stderr, "serve: %v\n", err)
			return 1
		}
		return serve(context.Background(), cfg, stdout)
	case "migrate":
		if len(args) != 2 {
			return badUsage(stderr)
		}
		switch args[1] {
		case "up", "baseline", "status":
			return runMigrate(args[1], stdout, stderr)
		}
		return badUsage(stderr)
	case "healthcheck":
		return healthcheck(stderr)
	}
	return badUsage(stderr)
}

func badUsage(stderr io.Writer) int {
	fmt.Fprintln(stderr, usage)
	return 2
}

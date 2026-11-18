// Command hermes-cloud is the Hermes Cloud control plane: the HTTP APIs, the job worker and the
// migration tool, in one binary.
package main

import (
	"fmt"
	"io"
	"os"
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
		return notImplemented(stderr, "serve")
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
		return notImplemented(stderr, "healthcheck")
	}
	return badUsage(stderr)
}

func badUsage(stderr io.Writer) int {
	fmt.Fprintln(stderr, usage)
	return 2
}

func notImplemented(stderr io.Writer, what string) int {
	fmt.Fprintf(stderr, "%s: not implemented\n", what)
	return 1
}

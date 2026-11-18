package main

import (
	"bytes"
	"strings"
	"testing"
)

const usageLine = "usage: hermes-cloud [serve|migrate up|migrate baseline|migrate status|healthcheck]"

func TestRunUnknownCommand(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run([]string{"nope"}, &out, &errOut); code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(errOut.String(), usageLine) {
		t.Fatalf("stderr = %q, want it to contain the usage line", errOut.String())
	}
}

func TestRunMigrateNeedsAction(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run([]string{"migrate"}, &out, &errOut); code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if code := run([]string{"migrate", "sideways"}, &out, &errOut); code != 2 {
		t.Fatalf("unknown migrate action: exit code = %d, want 2", code)
	}
}

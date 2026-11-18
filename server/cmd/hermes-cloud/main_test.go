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

func TestRunMigrateWithoutDatabaseURL(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	for _, action := range []string{"up", "baseline", "status"} {
		var out, errOut bytes.Buffer
		if code := run([]string{"migrate", action}, &out, &errOut); code != 1 {
			t.Fatalf("migrate %s: exit code = %d, want 1", action, code)
		}
		if !strings.Contains(errOut.String(), "DATABASE_URL is not set") {
			t.Fatalf("migrate %s: stderr = %q", action, errOut.String())
		}
	}
}

func TestRunMigrateErrorHidesURL(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgresql://hermes:secret-pw-value@127.0.0.1:1/none")
	var out, errOut bytes.Buffer
	if code := run([]string{"migrate", "status"}, &out, &errOut); code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
	if strings.Contains(errOut.String(), "secret-pw-value") {
		t.Fatalf("stderr leaks the password: %q", errOut.String())
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

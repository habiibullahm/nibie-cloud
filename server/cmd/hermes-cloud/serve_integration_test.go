//go:build integration

package main

import (
	"bytes"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/habiibullahm/nibie-cloud/server/internal/testutil/pgtest"
)

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func buildBinary(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "hermes-cloud")
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	return bin
}

// TestServeLifecycle starts the real binary: it becomes ready, answers healthcheck, listens on loopback
// only, and exits 0 on SIGTERM (Review Focus 5).
func TestServeLifecycle(t *testing.T) {
	bin := buildBinary(t)
	port := freePort(t)
	env := []string{
		"PATH=" + os.Getenv("PATH"),
		"NODE_ENV=test",
		"DATABASE_URL=" + pgtest.Fresh(t, "") + "?schema=public",
		"HERMES_IMAGE=hermes-stub:0.1.0",
		"ADMIN_TOKEN=" + strings.Repeat("a", 24),
		"HERMES_MASTER_KEY=" + strings.Repeat("k", 32),
		"HERMES_DISK_QUOTA=off",
		"HERMES_EGRESS_POLICY=off",
		"REDIS_URL=redis://127.0.0.1:6380",
		"PORT=" + strconv.Itoa(port),
	}
	var logs bytes.Buffer
	cmd := exec.Command(bin)
	cmd.Env, cmd.Dir, cmd.Stdout, cmd.Stderr = env, t.TempDir(), &logs, &logs
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	t.Cleanup(func() { _ = cmd.Process.Kill() })

	url := "http://127.0.0.1:" + strconv.Itoa(port)
	deadline := time.Now().Add(10 * time.Second)
	for {
		res, err := http.Get(url + "/readyz")
		if err == nil {
			res.Body.Close()
			if res.StatusCode == 200 {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("/readyz not 200 within 10 s (last err %v)\n%s", err, logs.String())
		}
		time.Sleep(100 * time.Millisecond)
	}

	hc := exec.Command(bin, "healthcheck")
	hc.Env = []string{"PORT=" + strconv.Itoa(port)}
	if out, err := hc.CombinedOutput(); err != nil {
		t.Fatalf("healthcheck: %v %s", err, out)
	}

	// Loopback only: the same port on any other local address refuses connections.
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		ipn, ok := a.(*net.IPNet)
		if !ok || ipn.IP.IsLoopback() || ipn.IP.To4() == nil {
			continue
		}
		if c, err := net.DialTimeout("tcp", net.JoinHostPort(ipn.IP.String(), strconv.Itoa(port)), time.Second); err == nil {
			c.Close()
			t.Fatalf("serve accepts connections on %s", ipn.IP)
		}
	}

	out := logs.String()
	if !strings.Contains(out, "REDIS_URL") || strings.Contains(out, strings.Repeat("a", 24)) || strings.Contains(out, "hermes_dev_only") {
		t.Fatalf("startup log must warn about REDIS_URL and hold no secrets:\n%s", out)
	}

	if runtime.GOOS == "windows" {
		t.Skip("SIGTERM is not available on Windows; the rest of the lifecycle passed")
	}
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-exited:
		if err != nil {
			t.Fatalf("exit after SIGTERM: %v\n%s", err, logs.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("still running 5 s after SIGTERM\n%s", logs.String())
	}
}

func TestServeRefusesBadConfig(t *testing.T) {
	bin := buildBinary(t)
	cmd := exec.Command(bin, "serve")
	cmd.Env, cmd.Dir = []string{"ADMIN_TOKEN=tooshort-secret-value"}, t.TempDir()
	out, err := cmd.CombinedOutput()
	if code := cmd.ProcessState.ExitCode(); err == nil || code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
	if !strings.Contains(string(out), "Invalid configuration") || strings.Contains(string(out), "tooshort-secret-value") {
		t.Fatalf("output = %s", out)
	}
}

func TestHealthcheckFailsWhenNothingListens(t *testing.T) {
	bin := buildBinary(t)
	hc := exec.Command(bin, "healthcheck")
	hc.Env = []string{"PORT=" + strconv.Itoa(freePort(t))}
	if err := hc.Run(); err == nil || hc.ProcessState.ExitCode() != 1 {
		t.Fatalf("healthcheck with nothing listening: exit %d, want 1", hc.ProcessState.ExitCode())
	}
}

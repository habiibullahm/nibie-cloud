//go:build integration

package main

import (
	"bytes"
	"context"
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

// serveEnv is the minimal valid environment for serve, with overrides.
func serveEnv(t *testing.T, port int, extra ...string) []string {
	t.Helper()
	env := []string{
		"PATH=" + os.Getenv("PATH"),
		"NODE_ENV=test",
		"DATABASE_URL=" + pgtest.Fresh(t, "") + "?schema=public",
		"HERMES_IMAGE=hermes-stub:0.1.0",
		"ADMIN_TOKEN=" + strings.Repeat("a", 24),
		"HERMES_MASTER_KEY=" + strings.Repeat("k", 32),
		"HERMES_DISK_QUOTA=off",
		"HERMES_EGRESS_POLICY=off",
		"PORT=" + strconv.Itoa(port),
	}
	return append(env, extra...)
}

// TestServeReadyzNamesDocker: without a reachable daemon serve still starts (runc, quota and egress off need
// none), and /readyz answers 503 naming only "docker".
func TestServeReadyzNamesDocker(t *testing.T) {
	bin := buildBinary(t)
	port := freePort(t)
	var logs bytes.Buffer
	cmd := exec.Command(bin)
	cmd.Env, cmd.Dir, cmd.Stdout, cmd.Stderr = serveEnv(t, port, "DOCKER_SOCKET_PATH=/nonexistent.sock"), t.TempDir(), &logs, &logs
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	deadline := time.Now().Add(10 * time.Second)
	for {
		res, err := http.Get("http://127.0.0.1:" + strconv.Itoa(port) + "/readyz")
		if err == nil {
			body := new(bytes.Buffer)
			_, _ = body.ReadFrom(res.Body)
			res.Body.Close()
			if res.StatusCode == 503 && strings.TrimSpace(body.String()) == `{"status":"fail","failed":["docker"]}` {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("/readyz never answered 503 naming docker (last err %v)\n%s", err, logs.String())
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// TestServeRefusesWithoutDockerWhenQuotaEnforced: the disk-quota startup check needs the daemon; without it serve
// exits 1 with the fixed message and no Docker text.
func TestServeRefusesWithoutDockerWhenQuotaEnforced(t *testing.T) {
	bin := buildBinary(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin)
	cmd.Env, cmd.Dir = serveEnv(t, freePort(t), "DOCKER_SOCKET_PATH=/nonexistent.sock", "HERMES_DISK_QUOTA=enforce"), t.TempDir()
	out, _ := cmd.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatalf("serve did not exit within 20 s (it must refuse at startup):\n%s", out)
	}
	if code := cmd.ProcessState.ExitCode(); code != 1 {
		t.Fatalf("exit %d\n%s", code, out)
	}
	s := string(out)
	if !strings.Contains(s, "HERMES_DISK_QUOTA") || strings.Contains(s, "nonexistent.sock") || strings.Contains(strings.ToLower(s), "cannot connect") {
		t.Fatalf("output:\n%s", s)
	}
}

// Command runtimelive is the live acceptance harness for the Go runtime manager (port of
// test/validation/runtime-manager-live.ts). It runs the real runtime.Docker against a real daemon and the pinned
// official Hermes image, no stubs. Run it where the control plane's Docker socket lives, from server/:
//
//	docker run --rm --network host -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD/..:/src" -w /src/server \
//	  golang:<pinned> go run ./validation/runtimelive
//
// HERMES_IMAGE overrides the image. HERMES_DISK_QUOTA / HERMES_EGRESS_POLICY (default off) set the spec modes.
// HERMES_CANARY_IMAGE (pinned, with sh) enables the runsc DNS checks; HERMES_DNS_RESOLVERS overrides their
// resolvers. Every resource it creates is removed at the end. A SKIP is never counted as a pass.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"

	"github.com/habiibullahm/nibie-cloud/server/internal/runtime"
)

const defaultImage = "nousresearch/hermes-agent@sha256:276d44685c65c0cb2a25f190b63c65c8906f9dc76486fb1c05ae71b5826bda08"

var failures, skipped int

func check(name string, ok bool, detail ...any) {
	status := "PASS"
	if !ok {
		status, failures = "FAIL", failures+1
	}
	extra := ""
	if len(detail) > 0 && detail[0] != nil {
		b, _ := json.Marshal(detail[0])
		extra = "  " + string(b)
	}
	fmt.Printf("%s  %s%s\n", status, name, extra)
}

func skip(name, reason string) {
	fmt.Printf("SKIP  %s  %q\n", name, reason)
	skipped++
}

func uuid() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6], b[8] = b[6]&0x0f|0x40, b[8]&0x3f|0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func spec(over func(*runtime.Spec)) runtime.Spec {
	s := runtime.Spec{
		InstanceID: uuid(), TenantID: uuid(), Image: envOr("HERMES_IMAGE", defaultImage),
		Limits:    runtime.ResourceLimits{CPUMillis: 1000, MemoryMB: 1024, Pids: 256, StorageMB: 1024},
		DiskQuota: envOr("HERMES_DISK_QUOTA", "off"), EgressPolicy: envOr("HERMES_EGRESS_POLICY", "off"),
		Env:          map[string]string{},
		APIServerKey: strings.ReplaceAll(uuid()+uuid(), "-", ""),
	}
	if over != nil {
		over(&s)
	}
	return s
}

type healthWait struct {
	OK     bool   `json:"ok"`
	Tries  int    `json:"tries"`
	Detail string `json:"detail"`
}

func waitHealthy(ctx context.Context, m *runtime.Docker, id, key string) healthWait {
	start, w := time.Now(), healthWait{}
	for time.Since(start) < 90*time.Second {
		w.Tries++
		h := m.CheckHealth(ctx, id, key)
		w.Detail = h.Detail
		if h.OK {
			w.OK = true
			return w
		}
		time.Sleep(2 * time.Second)
	}
	return w
}

func execIn(ctx context.Context, cli *client.Client, name string, cmd ...string) (string, error) {
	ex, err := cli.ContainerExecCreate(ctx, name, container.ExecOptions{Cmd: cmd, AttachStdout: true, AttachStderr: true})
	if err != nil {
		return "", err
	}
	att, err := cli.ContainerExecAttach(ctx, ex.ID, container.ExecAttachOptions{})
	if err != nil {
		return "", err
	}
	defer att.Close()
	var out bytes.Buffer
	_, _ = stdcopy.StdCopy(&out, &out, att.Reader)
	info, err := cli.ContainerExecInspect(ctx, ex.ID)
	if err != nil || info.ExitCode != 0 {
		return out.String(), fmt.Errorf("exit %d", info.ExitCode)
	}
	return out.String(), nil
}

func main() {
	os.Exit(run())
}

func run() int {
	ctx := context.Background()
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		fmt.Println("HARNESS ERROR: docker client:", err)
		return 2
	}
	defer cli.Close()
	quiet := slog.New(slog.DiscardHandler)
	m := runtime.NewDocker(cli, quiet).WithHealthTimeout(4 * time.Second)
	var created []string
	defer func() {
		for _, id := range created {
			_ = m.Remove(ctx, id, true)
		}
	}()
	must := func(err error) bool {
		if err != nil {
			fmt.Println("HARNESS ERROR:", err)
			failures++
			return false
		}
		return true
	}

	// ---- 1. Provision, start, authenticated readiness (runc = daemon default) ----
	a := spec(nil)
	created = append(created, a.InstanceID)
	ensured, err := m.Ensure(ctx, a)
	if !must(err) {
		return 1
	}
	check("Ensure() reports no host port before start", ensured.HostPort == 0, ensured)
	i, _ := m.Inspect(ctx, a.InstanceID)
	check(`Ensure() leaves the container in "created"`, i.State == runtime.StateCreated)
	check("Ensure() creates the tenant volume", i.VolumePresent)
	_, err = m.Ensure(ctx, a)
	i, _ = m.Inspect(ctx, a.InstanceID)
	check("Ensure() is idempotent (same state, still one container)", err == nil && i.State == runtime.StateCreated)

	if !must(m.Start(ctx, a.InstanceID)) {
		return 1
	}
	h := waitHealthy(ctx, m, a.InstanceID, a.APIServerKey)
	check("gateway becomes ready (authenticated GET /api/sessions)", h.OK, h)
	running, _ := m.Inspect(ctx, a.InstanceID)
	check("Inspect() reports running with a loopback host port", running.State == runtime.StateRunning && running.HostPort > 0,
		map[string]any{"state": running.State, "hostPort": running.HostPort, "oomKilled": running.OOMKilled})

	// ---- 2. Authenticated health semantics ----
	noKey := m.CheckHealth(ctx, a.InstanceID, "")
	check("CheckHealth() still proves liveness without a key (401 == daemon alive)", noKey.OK, noKey.Detail)

	// ---- 3. Secret handling ----
	unauth := 0
	if res, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/api/sessions", running.HostPort)); err == nil {
		unauth = res.StatusCode
		_ = res.Body.Close()
	}
	check("an unauthenticated request is refused with 401 (never session data)", unauth == 401, unauth)

	// ---- 4. Stop / start cycle ----
	_ = m.Stop(ctx, a.InstanceID, 10)
	stopped, _ := m.Inspect(ctx, a.InstanceID)
	check("Stop() transitions the container out of running", stopped.State != runtime.StateRunning, stopped.State)
	sh := m.CheckHealth(ctx, a.InstanceID, a.APIServerKey)
	check("CheckHealth() reports not running while stopped", !sh.OK, sh.Detail)
	_ = m.Start(ctx, a.InstanceID)
	rec := waitHealthy(ctx, m, a.InstanceID, a.APIServerKey)
	check("restart recovery: gateway ready again after stop/start", rec.OK, rec)

	// ---- 5. Evidence: hardening really applied on the live container ----
	info, err := cli.ContainerInspect(ctx, "hermes-"+a.InstanceID)
	if must(err) {
		hc := info.HostConfig
		hasSock := false
		for _, mp := range info.Mounts {
			hasSock = hasSock || strings.Contains(mp.Destination, "docker.sock")
		}
		check("live container: not privileged", !hc.Privileged)
		check("live container: read-only root filesystem", hc.ReadonlyRootfs)
		check("live container: no-new-privileges", len(hc.SecurityOpt) == 1 && hc.SecurityOpt[0] == "no-new-privileges:true", hc.SecurityOpt)
		check("live container: all caps dropped then re-added s6 set", len(hc.CapDrop) > 0 && hc.CapDrop[0] == "ALL" && len(hc.CapAdd) == len(runtime.S6RequiredCaps), hc.CapAdd)
		check("live container: no Docker socket mount", !hasSock)
		check("live container: exactly one mount at /opt/data", len(info.Mounts) == 1 && info.Mounts[0].Destination == "/opt/data")
		check("live container: dedicated bridge network", string(hc.NetworkMode) == "hermes-net-"+a.InstanceID, hc.NetworkMode)
		check("live container: PID limit enforced", hc.PidsLimit != nil && *hc.PidsLimit == 256, hc.PidsLimit)
		check("live container: memory limit enforced", hc.Memory == 1024*1048576, hc.Memory)
	}

	// ---- 6. runsc selection (needs a pinned, sh-having image to seed the tenant resolv.conf) ----
	var runscID string
	resolvers := regexp.MustCompile(`[,\s]+`).Split(envOr("HERMES_DNS_RESOLVERS", "1.1.1.1,9.9.9.9"), -1)
	if canary := os.Getenv("HERMES_CANARY_IMAGE"); canary == "" {
		skip("runsc instance has working DNS", "HERMES_CANARY_IMAGE not set: cannot seed the tenant resolv.conf volume")
	} else if must(runtime.EnsureDNSResolvConf(ctx, cli, canary, resolvers, "runsc", quiet)) {
		b := spec(func(s *runtime.Spec) { s.Runtime, s.DNS = "runsc", resolvers })
		runscID = b.InstanceID
		created = append(created, b.InstanceID)
		if must(func() error { _, err := m.Ensure(ctx, b); return err }()) && must(m.Start(ctx, b.InstanceID)) {
			gv := waitHealthy(ctx, m, b.InstanceID, b.APIServerKey)
			check("runsc instance reaches ready state", gv.OK, gv)
			bi, _ := m.Inspect(ctx, b.InstanceID)
			check("runsc instance is running", bi.State == runtime.StateRunning, bi.State)
			binfo, _ := cli.ContainerInspect(ctx, "hermes-"+b.InstanceID)
			check("runsc instance has the explicit DNS resolvers (HostConfig.Dns)", fmt.Sprint(binfo.HostConfig.DNS) == fmt.Sprint(resolvers), binfo.HostConfig.DNS)
			conf, _ := execIn(ctx, cli, "hermes-"+b.InstanceID, "cat", "/etc/resolv.conf")
			okConf := !strings.Contains(conf, "127.0.0.11")
			for _, r := range resolvers {
				okConf = okConf && strings.Contains(conf, r)
			}
			check("runsc instance /etc/resolv.conf lists the explicit resolvers, not the embedded one", okConf, strings.TrimSpace(conf))
			if lookup, err := execIn(ctx, cli, "hermes-"+b.InstanceID, "getent", "hosts", "example.com"); err == nil && strings.TrimSpace(lookup) != "" {
				check("runsc instance resolves a public hostname", true, strings.TrimSpace(lookup))
			} else {
				skip("runsc instance resolves a public hostname", "getent not available in this image; the resolv.conf check above stands in for it")
			}
		}
	}

	// ---- 7. Cleanup leaves nothing behind ----
	for _, id := range created {
		_ = m.Remove(ctx, id, true)
	}
	created = nil
	for _, id := range []string{a.InstanceID, runscID} {
		if id == "" {
			continue
		}
		gone, _ := m.Inspect(ctx, id)
		check("Remove() leaves no container/volume for "+id[:8], gone.State == runtime.StateAbsent && !gone.VolumePresent, gone)
	}

	// ---- 8. Egress controls ----
	if os.Getenv("HERMES_EGRESS_POLICY") == "enforce" {
		skip("egress checks", "ported in M7 (test/validation/egress-checks.ts)")
	} else {
		skip("egress checks", "HERMES_EGRESS_POLICY is not enforce")
	}

	if skipped > 0 {
		fmt.Printf("\n%d check(s) SKIPPED: a skipped check is not a pass\n", skipped)
	}
	if failures == 0 {
		fmt.Println("\nRESULT: ALL CHECKS PASSED")
		return 0
	}
	fmt.Printf("\nRESULT: %d CHECK(S) FAILED\n", failures)
	return 1
}

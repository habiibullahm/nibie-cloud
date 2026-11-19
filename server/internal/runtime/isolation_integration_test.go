//go:build integration

package runtime

import (
	"context"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/habiibullahm/nibie-cloud/server/internal/testutil/stubimage"
)

// Port of test/integration/isolation.test.ts: two live tenants, checked from inside.
func TestTenantIsolation(t *testing.T) {
	e := live(t)
	ctx := context.Background()
	a, b := e.newSpec(t), e.newSpec(t)
	for _, s := range []Spec{a, b} {
		mustEnsureStart(t, e.m, s)
		waitHealthy(t, e.m, s.InstanceID, s.APIServerKey)
	}
	nameA, nameB := idOf(t, a.InstanceID).ContainerName(), idOf(t, b.InstanceID).ContainerName()
	sh := func(container, script string) (int, string) {
		return stubimage.Exec(t, e.cli, container, "sh", "-c", script)
	}

	t.Run("enforces the hardening baseline on the live container", func(t *testing.T) {
		info, err := e.cli.ContainerInspect(ctx, nameA)
		if err != nil {
			t.Fatal(err)
		}
		h := info.HostConfig
		// Newer daemons report capabilities with a CAP_ prefix; the set is what matters.
		caps := make([]string, 0, len(h.CapAdd))
		for _, c := range h.CapAdd {
			caps = append(caps, strings.TrimPrefix(c, "CAP_"))
		}
		slices.Sort(caps)
		want := slices.Clone(S6RequiredCaps)
		slices.Sort(want)
		if h.Privileged || !h.ReadonlyRootfs || !slices.Equal([]string(h.CapDrop), []string{"ALL"}) || !slices.Equal(caps, want) {
			t.Fatalf("privileged %v readonly %v drop %v add %v", h.Privileged, h.ReadonlyRootfs, h.CapDrop, h.CapAdd)
		}
		if !slices.Contains(h.SecurityOpt, "no-new-privileges:true") || strings.Contains(strings.Join(h.SecurityOpt, ","), "unconfined") {
			t.Fatalf("security opt %v", h.SecurityOpt)
		}
		if h.PidsLimit == nil || *h.PidsLimit != 128 || h.Memory != 268435456 || h.MemorySwap != 268435456 || h.NanoCPUs != 500000000 {
			t.Fatalf("limits pids %v mem %d swap %d cpu %d", h.PidsLimit, h.Memory, h.MemorySwap, h.NanoCPUs)
		}
		if string(h.NetworkMode) != idOf(t, a.InstanceID).NetworkName() || h.PidMode != "" || h.IpcMode == "host" || info.Config.User != "" {
			t.Fatalf("network %s pid %s ipc %s user %q", h.NetworkMode, h.PidMode, h.IpcMode, info.Config.User)
		}
	})
	t.Run("mounts exactly one tenant volume and never the Docker socket", func(t *testing.T) {
		info, _ := e.cli.ContainerInspect(ctx, nameA)
		if len(info.Mounts) != 1 || info.Mounts[0].Type != "volume" || info.Mounts[0].Destination != "/opt/data" || info.Mounts[0].Name != idOf(t, a.InstanceID).VolumeName() {
			t.Fatalf("mounts %+v", info.Mounts)
		}
		code, out := sh(nameA, "ls /var/run/docker.sock /run/docker.sock 2>&1")
		if code == 0 || regexp.MustCompile(`(?m)^/var/run/docker\.sock$`).MatchString(out) {
			t.Fatalf("docker socket visible: %d %s", code, out)
		}
	})
	t.Run("drops the gateway to hermes (10000) with a read-only root filesystem and writable data", func(t *testing.T) {
		if _, out := sh(nameA, "ps -o user,args"); !regexp.MustCompile(`(?m)^hermes\s+nc -lk`).MatchString(out) {
			t.Fatalf("ps:\n%s", out)
		}
		if _, out := sh(nameA, "stat -c %u /opt/data"); strings.TrimSpace(out) != "10000" {
			t.Fatalf("owner %q", out)
		}
		if code, _ := sh(nameA, "touch /etc/hermes-x"); code == 0 {
			t.Fatal("root filesystem is writable")
		}
		for _, p := range []string{"/opt/data/x", "/tmp/x"} {
			if code, out := sh(nameA, "touch "+p); code != 0 {
				t.Fatalf("touch %s: %s", p, out)
			}
		}
	})
	t.Run("leaves the gateway process with no effective capabilities after the privilege drop", func(t *testing.T) {
		_, out := sh(nameA, "grep CapEff /proc/$(ps -o pid,args | awk '/nc -lk/ && !/awk/ {print $1; exit}')/status")
		if !regexp.MustCompile(`(?m)CapEff:\s+0+$`).MatchString(out) {
			t.Fatalf("CapEff: %s", out)
		}
	})
	t.Run("cannot see another tenant's data", func(t *testing.T) {
		sh(nameB, "echo secret-b > /opt/data/b-only")
		if _, out := sh(nameA, "ls /opt/data"); strings.Contains(out, "b-only") {
			t.Fatal("tenant A sees tenant B's file")
		}
		if code, out := sh(nameA, "cat /opt/data/b-only"); code == 0 || strings.Contains(out, "secret-b") {
			t.Fatalf("tenant A read tenant B's data: %d %s", code, out)
		}
	})
	t.Run("cannot reach another tenant container over the network", func(t *testing.T) {
		binfo, _ := e.cli.ContainerInspect(ctx, nameB)
		bIP := ""
		for _, n := range binfo.NetworkSettings.Networks {
			bIP = n.IPAddress
		}
		if bIP == "" {
			t.Fatal("no IP for tenant B")
		}
		get := func(host, key string) int {
			code, _ := sh(nameA, "wget -T 3 -qO- --header 'Authorization: Bearer "+key+"' http://"+host+":8642/api/sessions")
			return code
		}
		if get("127.0.0.1", a.APIServerKey) != 0 {
			t.Fatal("control probe failed: the check cannot prove anything")
		}
		if get(bIP, b.APIServerKey) == 0 || get(nameB, b.APIServerKey) == 0 {
			t.Fatal("tenant A reached tenant B")
		}
	})
	t.Run("enforces the memory limit: an over-allocating process is killed, the container survives", func(t *testing.T) {
		_, out := sh(nameA, `x=$(head -c 400000000 /dev/zero | tr "\0" a); echo ${#x}`)
		if strings.TrimSpace(out) == "400000000" {
			t.Fatal("400 MB allocated inside a 256 MB container")
		}
		if i, _ := e.m.Inspect(ctx, a.InstanceID); i.State != StateRunning {
			t.Fatalf("state %s", i.State)
		}
	})
	t.Run("caps the number of processes at the PID limit", func(t *testing.T) {
		code, out := sh(nameA, "for i in $(seq 1 400); do sleep 60 & done")
		if code == 0 || !strings.Contains(out, "can't fork") {
			t.Fatalf("code %d out %s", code, out)
		}
		top, err := e.cli.ContainerTop(ctx, nameA, nil)
		if err != nil {
			t.Fatal(err)
		}
		if n := len(top.Processes); n <= 50 || n > 128 {
			t.Fatalf("%d processes", n)
		}
		if i, _ := e.m.Inspect(ctx, a.InstanceID); i.State != StateRunning {
			t.Fatalf("state %s", i.State)
		}
	})
}

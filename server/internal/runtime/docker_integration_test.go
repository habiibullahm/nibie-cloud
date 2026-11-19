//go:build integration

package runtime

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"

	"github.com/habiibullahm/nibie-cloud/server/internal/shared/apperr"
	"github.com/habiibullahm/nibie-cloud/server/internal/testutil/stubimage"
)

type liveEnv struct {
	cli   *client.Client
	m     *Docker
	image string
}

func live(t *testing.T) liveEnv {
	t.Helper()
	cli := stubimage.Client(t)
	return liveEnv{cli: cli, m: NewDocker(cli, slog.New(slog.DiscardHandler)), image: stubimage.Ensure(t, cli)}
}

// newSpec returns a fresh spec whose resources are removed when the test ends, also on failure.
func (e liveEnv) newSpec(t *testing.T) Spec {
	t.Helper()
	s := Spec{
		InstanceID: newUUID(), TenantID: newUUID(), Image: e.image,
		Limits:    ResourceLimits{CPUMillis: 500, MemoryMB: 256, Pids: 128, StorageMB: 1024},
		DiskQuota: "off", EgressPolicy: "off", Env: map[string]string{},
		APIServerKey: strings.ReplaceAll(newUUID()+newUUID(), "-", ""),
	}
	t.Cleanup(func() { _ = e.m.Remove(context.Background(), s.InstanceID, true) })
	return s
}

func (e liveEnv) count(t *testing.T, s Spec) (containers, volumes, networks int) {
	t.Helper()
	ctx := context.Background()
	id := idOf(t, s.InstanceID)
	cs, err := e.cli.ContainerList(ctx, container.ListOptions{All: true, Filters: filters.NewArgs(filters.Arg("label", LabelInstance+"="+string(id)))})
	if err != nil {
		t.Fatal(err)
	}
	vs, err := e.cli.VolumeList(ctx, volume.ListOptions{Filters: filters.NewArgs(filters.Arg("name", id.VolumeName()))})
	if err != nil {
		t.Fatal(err)
	}
	ns, err := e.cli.NetworkList(ctx, network.ListOptions{Filters: filters.NewArgs(filters.Arg("name", id.NetworkName()))})
	if err != nil {
		t.Fatal(err)
	}
	return len(cs), len(vs.Volumes), len(ns)
}

// Port of test/integration/runtime-manager.test.ts.
func TestDockerManagerLive(t *testing.T) {
	e := live(t)
	ctx := context.Background()

	t.Run("ensure creates volume, network and an unstarted container", func(t *testing.T) {
		s := e.newSpec(t)
		if _, err := e.m.Ensure(ctx, s); err != nil {
			t.Fatal(err)
		}
		i, err := e.m.Inspect(ctx, s.InstanceID)
		if err != nil || i.State != StateCreated || !i.VolumePresent {
			t.Fatalf("%+v %v", i, err)
		}
	})
	t.Run("refuses an existing unquotaed volume in enforce mode and never creates a container", func(t *testing.T) {
		s := e.newSpec(t)
		s.DiskQuota = "enforce"
		if _, err := e.cli.VolumeCreate(ctx, volume.CreateOptions{Name: idOf(t, s.InstanceID).VolumeName(), Labels: map[string]string{LabelManaged: "true"}}); err != nil {
			t.Fatal(err)
		}
		if _, err := e.m.Ensure(ctx, s); !errors.Is(err, apperr.VolumeQuotaMissing) {
			t.Fatalf("err %v", err)
		}
		if i, _ := e.m.Inspect(ctx, s.InstanceID); i.State != StateAbsent {
			t.Fatalf("state %s", i.State)
		}
	})
	t.Run("ensure is idempotent: one container, one volume, one network", func(t *testing.T) {
		s := e.newSpec(t)
		for range 2 {
			if _, err := e.m.Ensure(ctx, s); err != nil {
				t.Fatal(err)
			}
		}
		if c, v, n := e.count(t, s); c != 1 || v != 1 || n != 1 {
			t.Fatalf("containers %d volumes %d networks %d", c, v, n)
		}
	})
	t.Run("start makes it running with a loopback host port and passing health check", func(t *testing.T) {
		s := e.newSpec(t)
		if _, err := e.m.Ensure(ctx, s); err != nil {
			t.Fatal(err)
		}
		if err := e.m.Start(ctx, s.InstanceID); err != nil {
			t.Fatal(err)
		}
		i, err := e.m.Inspect(ctx, s.InstanceID)
		if err != nil || i.State != StateRunning || i.HostPort < 1024 || i.HostPort > 65535 {
			t.Fatalf("%+v %v", i, err)
		}
		waitHealthy(t, e.m, s.InstanceID, "")
		if h := e.m.CheckHealth(ctx, s.InstanceID, s.APIServerKey); !h.OK {
			t.Fatalf("with the right key: %+v", h)
		}
		if h := e.m.CheckHealth(ctx, s.InstanceID, "wrong-key"); h.Detail != AuthRejectedDetail {
			t.Fatalf("with a wrong key: %+v", h)
		}
		info, _ := e.cli.ContainerInspect(ctx, idOf(t, s.InstanceID).ContainerName())
		if b := info.NetworkSettings.Ports[containerPortKey()]; len(b) == 0 || b[0].HostIP != "127.0.0.1" {
			t.Fatalf("port binding %+v", b)
		}
	})
	t.Run("stop then start works and stop is idempotent", func(t *testing.T) {
		s := e.newSpec(t)
		mustEnsureStart(t, e.m, s)
		if err := e.m.Stop(ctx, s.InstanceID, 2); err != nil {
			t.Fatal(err)
		}
		if i, _ := e.m.Inspect(ctx, s.InstanceID); i.State != StateExited {
			t.Fatalf("state %s", i.State)
		}
		if err := e.m.Stop(ctx, s.InstanceID, 2); err != nil {
			t.Fatalf("second stop: %v", err)
		}
		if err := e.m.Start(ctx, s.InstanceID); err != nil {
			t.Fatal(err)
		}
		if i, _ := e.m.Inspect(ctx, s.InstanceID); i.State != StateRunning {
			t.Fatalf("state %s", i.State)
		}
	})
	t.Run("restart produces a newer startedAt", func(t *testing.T) {
		s := e.newSpec(t)
		mustEnsureStart(t, e.m, s)
		before, _ := e.m.Inspect(ctx, s.InstanceID)
		time.Sleep(1100 * time.Millisecond)
		if err := e.m.Restart(ctx, s.InstanceID); err != nil {
			t.Fatal(err)
		}
		after, _ := e.m.Inspect(ctx, s.InstanceID)
		if before.StartedAt == nil || after.StartedAt == nil || !after.StartedAt.After(*before.StartedAt) {
			t.Fatalf("before %v after %v", before.StartedAt, after.StartedAt)
		}
	})
	t.Run("remove on an absent instance is a no-op and inspect reports absent", func(t *testing.T) {
		id := newUUID()
		if err := e.m.Remove(ctx, id, true); err != nil {
			t.Fatal(err)
		}
		if i, err := e.m.Inspect(ctx, id); err != nil || i.State != StateAbsent || i.VolumePresent {
			t.Fatalf("%+v %v", i, err)
		}
	})
	t.Run("checkHealth reports not ok (without throwing) when stopped", func(t *testing.T) {
		s := e.newSpec(t)
		if _, err := e.m.Ensure(ctx, s); err != nil {
			t.Fatal(err)
		}
		if h := e.m.CheckHealth(ctx, s.InstanceID, ""); h.OK || h.Detail == "" {
			t.Fatalf("%+v", h)
		}
	})
	t.Run("remove keeps the volume unless deleteVolume is true", func(t *testing.T) {
		s := e.newSpec(t)
		if _, err := e.m.Ensure(ctx, s); err != nil {
			t.Fatal(err)
		}
		if err := e.m.Remove(ctx, s.InstanceID, false); err != nil {
			t.Fatal(err)
		}
		if i, _ := e.m.Inspect(ctx, s.InstanceID); i.State != StateAbsent || !i.VolumePresent {
			t.Fatalf("%+v", i)
		}
		if err := e.m.Remove(ctx, s.InstanceID, true); err != nil {
			t.Fatal(err)
		}
		if i, _ := e.m.Inspect(ctx, s.InstanceID); i.VolumePresent {
			t.Fatal("volume still present")
		}
	})
	t.Run("maps an unreachable Docker daemon to RuntimeUnavailableError", func(t *testing.T) {
		dead, err := client.NewClientWithOpts(client.WithHost("unix:///nonexistent.sock"), client.WithVersion("1.47"))
		if err != nil {
			t.Fatal(err)
		}
		m := NewDocker(dead, slog.New(slog.DiscardHandler))
		if _, err := m.Inspect(ctx, newUUID()); !errors.Is(err, apperr.RuntimeUnavailable) {
			t.Fatalf("inspect: %v", err)
		}
		if _, err := m.Ensure(ctx, e.newSpec(t)); !errors.Is(err, apperr.RuntimeUnavailable) {
			t.Fatalf("ensure: %v", err)
		}
	})
}

// TestConcurrentEnsure: a user start racing the reconciler (Review Focus 2) leaves one of each and no error.
func TestConcurrentEnsure(t *testing.T) {
	e := live(t)
	s := e.newSpec(t)
	var wg sync.WaitGroup
	errs := make([]error, 5)
	for i := range errs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, errs[i] = e.m.Ensure(context.Background(), s)
		}()
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("ensure %d: %v", i, err)
		}
	}
	if c, v, n := e.count(t, s); c != 1 || v != 1 || n != 1 {
		t.Fatalf("containers %d volumes %d networks %d", c, v, n)
	}
}

// seedVolume writes content as config.yaml into the instance's (new) volume with a throwaway container.
func seedVolume(t *testing.T, e liveEnv, s Spec, content string) {
	t.Helper()
	ctx := context.Background()
	id := idOf(t, s.InstanceID)
	if _, err := e.cli.VolumeCreate(ctx, volume.CreateOptions{Name: id.VolumeName(), Labels: map[string]string{LabelManaged: "true", LabelInstance: string(id)}}); err != nil {
		t.Fatal(err)
	}
	name := "hermes-seed-" + newUUID()
	_, err := e.cli.ContainerCreate(ctx, &container.Config{Image: e.image, Entrypoint: []string{"sh", "-c", `printf '%s' "$1" > /opt/data/config.yaml`, "seed", content}, Labels: map[string]string{LabelManaged: "true"}},
		&container.HostConfig{Binds: []string{id.VolumeName() + ":/opt/data"}}, nil, nil, name)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = e.cli.ContainerRemove(ctx, name, container.RemoveOptions{Force: true}) }()
	if err := e.cli.ContainerStart(ctx, name, container.StartOptions{}); err != nil {
		t.Fatal(err)
	}
	wait, errc := e.cli.ContainerWait(ctx, name, container.WaitConditionNotRunning)
	select {
	case r := <-wait:
		if r.StatusCode != 0 {
			t.Fatalf("seed exit %d", r.StatusCode)
		}
	case err := <-errc:
		t.Fatal(err)
	}
}

func readConfig(t *testing.T, e liveEnv, s Spec) (string, bool) {
	t.Helper()
	rc, _, err := e.cli.CopyFromContainer(context.Background(), idOf(t, s.InstanceID).ContainerName(), DataMount+"/config.yaml")
	if err != nil {
		return "", false
	}
	defer rc.Close()
	b, err := CollectCapped(rc, MaxConfigBytes)
	if err != nil {
		t.Fatal(err)
	}
	return ReadFirstFile(b)
}

func TestEnsureSeedsModelBlock(t *testing.T) {
	e := live(t)
	s := e.newSpec(t)
	seedVolume(t, e, s, "# customer notes\nterminal:\n  backend: local\n")
	s.Model = &ModelChange{Config: ModelConfig{Default: "gpt-x", BaseURL: "https://llm.example.test/v1", KeyEnv: ProviderKeyEnv}}
	if _, err := e.m.Ensure(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	got, ok := readConfig(t, e, s)
	if !ok || !strings.Contains(got, "key_env: HERMES_PROVIDER_API_KEY") || !strings.Contains(got, "# customer notes") || !strings.Contains(got, "backend: local") {
		t.Fatalf("config.yaml:\n%s", got)
	}
}

func TestEnsureRemovesContainerWhenModelApplyFails(t *testing.T) {
	e := live(t)
	s := e.newSpec(t)
	seedVolume(t, e, s, "model: [unclosed\n  : :")
	s.Model = &ModelChange{Config: ModelConfig{Default: "gpt-x", BaseURL: "https://llm.example.test/v1", KeyEnv: ProviderKeyEnv}}
	if _, err := e.m.Ensure(context.Background(), s); !errors.Is(err, apperr.ConfigUnreadable) {
		t.Fatalf("err %v, want config_unreadable", err)
	}
	if i, _ := e.m.Inspect(context.Background(), s.InstanceID); i.State != StateAbsent || !i.VolumePresent {
		t.Fatalf("container must be removed, the volume kept: %+v", i)
	}
}

func mustEnsureStart(t *testing.T, m *Docker, s Spec) {
	t.Helper()
	if _, err := m.Ensure(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	if err := m.Start(context.Background(), s.InstanceID); err != nil {
		t.Fatal(err)
	}
}

func waitHealthy(t *testing.T, m *Docker, id, key string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		h := m.CheckHealth(context.Background(), id, key)
		if h.OK {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("not healthy within 30 s: %+v", h)
		}
		time.Sleep(300 * time.Millisecond)
	}
}

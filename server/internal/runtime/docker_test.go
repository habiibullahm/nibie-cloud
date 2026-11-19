package runtime

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
	"github.com/docker/go-connections/nat"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"

	"github.com/habiibullahm/nibie-cloud/server/internal/shared/apperr"
)

// statusErr is a Docker error with an HTTP status, as the fakes return them.
type statusErr struct {
	code int
	msg  string
}

func (e statusErr) Error() string   { return e.msg }
func (e statusErr) StatusCode() int { return e.code }

func notFound() error { return statusErr{404, "not found"} }

func newUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6], b[8] = b[6]&0x0f|0x40, b[8]&0x3f|0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// fakeAPI is an in-memory Docker with just the surface Ensure, the asserts, VolumeUsage and CheckHealth use.
// Any other method panics through the nil embedded interface.
type fakeAPI struct {
	DockerAPI
	networks    map[string]network.Inspect
	volumes     map[string]volume.Volume
	createdNets []network.CreateOptions
	createdVols []volume.CreateOptions
	netErr      error
	raceWith    *network.Inspect
	rejectSized bool
	inspect     *container.InspectResponse
	du          types.DiskUsage
	duCalls     []types.DiskUsageOptions
}

func newFake() *fakeAPI {
	return &fakeAPI{networks: map[string]network.Inspect{}, volumes: map[string]volume.Volume{}}
}

func (f *fakeAPI) NetworkInspect(_ context.Context, name string, _ network.InspectOptions) (network.Inspect, error) {
	if n, ok := f.networks[name]; ok {
		return n, nil
	}
	return network.Inspect{}, notFound()
}

func (f *fakeAPI) NetworkCreate(_ context.Context, name string, o network.CreateOptions) (network.CreateResponse, error) {
	if f.raceWith != nil {
		f.networks[name] = *f.raceWith // a concurrent Ensure won the race
	}
	if f.netErr != nil {
		return network.CreateResponse{}, f.netErr
	}
	f.createdNets = append(f.createdNets, o)
	f.networks[name] = network.Inspect{Name: name, Options: o.Options}
	return network.CreateResponse{}, nil
}

func (f *fakeAPI) VolumeInspect(_ context.Context, name string) (volume.Volume, error) {
	if v, ok := f.volumes[name]; ok {
		return v, nil
	}
	return volume.Volume{}, notFound()
}

func (f *fakeAPI) VolumeCreate(_ context.Context, o volume.CreateOptions) (volume.Volume, error) {
	if o.DriverOpts["size"] != "" && f.rejectSized {
		return volume.Volume{}, statusErr{400, "create " + o.Name + ": quota size requested but no quota support"}
	}
	f.createdVols = append(f.createdVols, o)
	v := volume.Volume{Name: o.Name, Options: o.DriverOpts, Labels: o.Labels}
	f.volumes[o.Name] = v
	return v, nil
}

func (f *fakeAPI) ContainerInspect(context.Context, string) (container.InspectResponse, error) {
	if f.inspect != nil {
		return *f.inspect, nil
	}
	return container.InspectResponse{}, notFound()
}

func (f *fakeAPI) ImageInspect(context.Context, string, ...client.ImageInspectOption) (image.InspectResponse, error) {
	return image.InspectResponse{}, nil
}

func (f *fakeAPI) ContainerCreate(context.Context, *container.Config, *container.HostConfig, *network.NetworkingConfig, *ocispec.Platform, string) (container.CreateResponse, error) {
	return container.CreateResponse{}, nil
}

func (f *fakeAPI) DiskUsage(_ context.Context, o types.DiskUsageOptions) (types.DiskUsage, error) {
	f.duCalls = append(f.duCalls, o)
	return f.du, nil
}

func quiet() *slog.Logger { return slog.New(slog.DiscardHandler) }

func unitSpec(egress, quota string) Spec {
	return Spec{
		InstanceID: newUUID(), TenantID: newUUID(), Image: "nousresearch/hermes-agent@sha256:" + fmt.Sprintf("%064d", 0),
		Limits: ResourceLimits{CPUMillis: 500, MemoryMB: 256, Pids: 128, StorageMB: 512}, DiskQuota: quota, EgressPolicy: egress,
		Env: map[string]string{},
	}
}

func idOf(t *testing.T, s string) ID {
	t.Helper()
	id, err := ParseID(s)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// --- Port of test/unit/network-policy.test.ts ('tenant network identity', 'assertNetworkPolicy') ---

func TestNetworkPolicy(t *testing.T) {
	ctx := context.Background()
	named := func(t *testing.T, s Spec) map[string]string {
		return map[string]string{BridgeNameOption: idOf(t, s.InstanceID).BridgeName()}
	}
	t.Run("creates the network with the hn bridge name and IPv6 off", func(t *testing.T) {
		f, s := newFake(), unitSpec("enforce", "enforce")
		if _, err := NewDocker(f, quiet()).Ensure(ctx, s); err != nil {
			t.Fatal(err)
		}
		if len(f.createdNets) != 1 || f.createdNets[0].EnableIPv6 == nil || *f.createdNets[0].EnableIPv6 || f.createdNets[0].Options[BridgeNameOption] != idOf(t, s.InstanceID).BridgeName() {
			t.Fatalf("created %+v", f.createdNets)
		}
	})
	t.Run("reuses an existing network that has the bridge name", func(t *testing.T) {
		f, s := newFake(), unitSpec("enforce", "enforce")
		f.networks[idOf(t, s.InstanceID).NetworkName()] = network.Inspect{Options: named(t, s)}
		if _, err := NewDocker(f, quiet()).Ensure(ctx, s); err != nil || len(f.createdNets) != 0 {
			t.Fatalf("err %v created %d", err, len(f.createdNets))
		}
	})
	t.Run("refuses an existing network without the bridge name when enforce", func(t *testing.T) {
		f, s := newFake(), unitSpec("enforce", "enforce")
		f.networks[idOf(t, s.InstanceID).NetworkName()] = network.Inspect{Options: map[string]string{"com.docker.network.bridge.enable_icc": "false"}}
		if _, err := NewDocker(f, quiet()).Ensure(ctx, s); !errors.Is(err, apperr.NetworkPolicyMissing) || len(f.createdNets) != 0 {
			t.Fatalf("err %v created %d", err, len(f.createdNets))
		}
	})
	t.Run("refuses an existing network with a different bridge name or no options when enforce", func(t *testing.T) {
		for _, opts := range []map[string]string{nil, {BridgeNameOption: "hnffffffffffff"}} {
			f, s := newFake(), unitSpec("enforce", "enforce")
			f.networks[idOf(t, s.InstanceID).NetworkName()] = network.Inspect{Options: opts}
			if _, err := NewDocker(f, quiet()).Ensure(ctx, s); !errors.Is(err, apperr.NetworkPolicyMissing) {
				t.Fatalf("%v: err %v", opts, err)
			}
		}
	})
	t.Run("accepts an unnamed network when off", func(t *testing.T) {
		f, s := newFake(), unitSpec("off", "enforce")
		f.networks[idOf(t, s.InstanceID).NetworkName()] = network.Inspect{}
		if _, err := NewDocker(f, quiet()).Ensure(ctx, s); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("after a create conflict (409) it re-checks the winner: right name is fine", func(t *testing.T) {
		f, s := newFake(), unitSpec("enforce", "enforce")
		f.netErr, f.raceWith = statusErr{409, "exists"}, &network.Inspect{Options: named(t, s)}
		if _, err := NewDocker(f, quiet()).Ensure(ctx, s); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("after a create conflict (409) it re-checks the winner: wrong name is refused, not retried", func(t *testing.T) {
		f, s := newFake(), unitSpec("enforce", "enforce")
		f.netErr, f.raceWith = statusErr{409, "exists"}, &network.Inspect{}
		if _, err := NewDocker(f, quiet()).Ensure(ctx, s); !errors.Is(err, apperr.NetworkPolicyMissing) {
			t.Fatalf("err %v", err)
		}
	})
	t.Run("a bridge-name collision with another network (403) is reported as NetworkPolicyMissingError", func(t *testing.T) {
		f := newFake()
		f.netErr = statusErr{403, "cannot create network x (hnaaaaaaaaaaaa): conflicts with network y (hnaaaaaaaaaaaa): networks have same bridge name"}
		_, err := NewDocker(f, quiet()).Ensure(ctx, unitSpec("enforce", "enforce"))
		if !errors.Is(err, apperr.NetworkPolicyMissing) || err.Error() != "Tenant bridge name is already in use" {
			t.Fatalf("err %v", err)
		}
	})
	t.Run("other create failures are not mistaken for a policy problem", func(t *testing.T) {
		f := newFake()
		f.netErr = statusErr{500, "boom with /var/lib/docker/secret path"}
		_, err := NewDocker(f, quiet()).Ensure(ctx, unitSpec("enforce", "enforce"))
		if err == nil || errors.Is(err, apperr.NetworkPolicyMissing) || err.Error() != "Docker operation failed (status 500)" {
			t.Fatalf("err %v (must not carry Docker's text)", err)
		}
	})
	t.Run("a bridge-name collision when off is not a policy error", func(t *testing.T) {
		f := newFake()
		f.netErr = statusErr{403, "networks have same bridge name"}
		if _, err := NewDocker(f, quiet()).Ensure(ctx, unitSpec("off", "enforce")); err == nil || errors.Is(err, apperr.NetworkPolicyMissing) {
			t.Fatalf("err %v", err)
		}
	})
	assert := func(t *testing.T, opts *map[string]string, mode string) error {
		f, id := newFake(), newUUID()
		if opts != nil {
			f.networks[idOf(t, id).NetworkName()] = network.Inspect{Options: *opts}
		}
		return NewDocker(f, quiet()).AssertNetworkPolicy(ctx, id, mode)
	}
	t.Run("assertNetworkPolicy refuses an existing network without the bridge name when enforce", func(t *testing.T) {
		if err := assert(t, &map[string]string{}, "enforce"); !errors.Is(err, apperr.NetworkPolicyMissing) {
			t.Fatalf("err %v", err)
		}
	})
	t.Run("assertNetworkPolicy refuses a network with a different bridge name when enforce", func(t *testing.T) {
		if err := assert(t, &map[string]string{BridgeNameOption: "hnffffffffffff"}, "enforce"); !errors.Is(err, apperr.NetworkPolicyMissing) {
			t.Fatalf("err %v", err)
		}
	})
	t.Run("assertNetworkPolicy refuses an absent network when enforce (cannot confirm the policy)", func(t *testing.T) {
		if err := assert(t, nil, "enforce"); !errors.Is(err, apperr.NetworkPolicyMissing) {
			t.Fatalf("err %v", err)
		}
	})
	t.Run("assertNetworkPolicy accepts a network that has the bridge name when enforce", func(t *testing.T) {
		f, id := newFake(), newUUID()
		f.networks[idOf(t, id).NetworkName()] = network.Inspect{Options: map[string]string{BridgeNameOption: idOf(t, id).BridgeName()}}
		if err := NewDocker(f, quiet()).AssertNetworkPolicy(ctx, id, "enforce"); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("assertNetworkPolicy does nothing when off, whatever the network looks like", func(t *testing.T) {
		if err := assert(t, nil, "off"); err != nil {
			t.Fatal(err)
		}
	})
}

// --- Port of test/unit/volume-quota.test.ts ('sized tenant volumes', 'assertVolumeQuota', 'volumeUsage') ---

func TestVolumeQuotaManager(t *testing.T) {
	ctx := context.Background()
	t.Run("creates the volume with the sized options when enforce", func(t *testing.T) {
		f, s := newFake(), unitSpec("off", "enforce")
		r, err := NewDocker(f, quiet()).Ensure(ctx, s)
		if err != nil || len(f.createdVols) != 1 || f.createdVols[0].Driver != "local" || f.createdVols[0].DriverOpts["size"] != "512m" || r.VolumeQuotaMB != 512 {
			t.Fatalf("err %v created %+v result %+v", err, f.createdVols, r)
		}
		if f.createdVols[0].Name != idOf(t, s.InstanceID).VolumeName() || f.createdVols[0].Labels[LabelManaged] != "true" {
			t.Fatalf("volume %+v", f.createdVols[0])
		}
	})
	t.Run("creates it without size options when off", func(t *testing.T) {
		f := newFake()
		r, err := NewDocker(f, quiet()).Ensure(ctx, unitSpec("off", "off"))
		if err != nil || len(f.createdVols[0].DriverOpts) != 0 || r.VolumeQuotaMB != 0 {
			t.Fatalf("err %v created %+v result %+v", err, f.createdVols, r)
		}
	})
	t.Run("reports the existing quota in MB through volumeQuotaMb", func(t *testing.T) {
		f, s := newFake(), unitSpec("off", "enforce")
		f.volumes[idOf(t, s.InstanceID).VolumeName()] = volume.Volume{Options: map[string]string{"size": "2g"}}
		r, err := NewDocker(f, quiet()).Ensure(ctx, s)
		if err != nil || r.VolumeQuotaMB != 2048 || len(f.createdVols) != 0 {
			t.Fatalf("err %v result %+v created %d", err, r, len(f.createdVols))
		}
	})
	t.Run("throws VolumeQuotaMissingError for an existing volume without a quota when enforce", func(t *testing.T) {
		f, s := newFake(), unitSpec("off", "enforce")
		f.volumes[idOf(t, s.InstanceID).VolumeName()] = volume.Volume{}
		if _, err := NewDocker(f, quiet()).Ensure(ctx, s); !errors.Is(err, apperr.VolumeQuotaMissing) {
			t.Fatalf("err %v", err)
		}
	})
	t.Run("does not throw for an existing unquotaed volume when off", func(t *testing.T) {
		f, s := newFake(), unitSpec("off", "off")
		f.volumes[idOf(t, s.InstanceID).VolumeName()] = volume.Volume{}
		if r, err := NewDocker(f, quiet()).Ensure(ctx, s); err != nil || r.VolumeQuotaMB != 0 {
			t.Fatalf("err %v result %+v", err, r)
		}
	})
	t.Run(`turns a create-time "no quota support" rejection into VolumeQuotaMissingError`, func(t *testing.T) {
		f := newFake()
		f.rejectSized = true
		if _, err := NewDocker(f, quiet()).Ensure(ctx, unitSpec("off", "enforce")); !errors.Is(err, apperr.VolumeQuotaMissing) {
			t.Fatalf("err %v", err)
		}
	})
	assert := func(opts *map[string]string, mode string) error {
		f, id := newFake(), newUUID()
		if opts != nil {
			name, _ := ParseID(id)
			f.volumes[name.VolumeName()] = volume.Volume{Options: *opts}
		}
		return NewDocker(f, quiet()).AssertVolumeQuota(ctx, id, mode)
	}
	t.Run("assertVolumeQuota refuses an existing volume without a quota when enforce", func(t *testing.T) {
		if err := assert(&map[string]string{}, "enforce"); !errors.Is(err, apperr.VolumeQuotaMissing) {
			t.Fatalf("err %v", err)
		}
	})
	t.Run("assertVolumeQuota refuses an absent volume when enforce (cannot confirm a quota)", func(t *testing.T) {
		if err := assert(nil, "enforce"); !errors.Is(err, apperr.VolumeQuotaMissing) {
			t.Fatalf("err %v", err)
		}
	})
	t.Run("assertVolumeQuota accepts a volume that has a quota when enforce", func(t *testing.T) {
		if err := assert(&map[string]string{"size": "512m"}, "enforce"); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("assertVolumeQuota does nothing when off, whatever the volume looks like", func(t *testing.T) {
		if err := assert(nil, "off"); err != nil {
			t.Fatal(err)
		}
	})
	vol := func(id string, managed bool, size *int64) *volume.Volume {
		labels := map[string]string{}
		if managed {
			labels[LabelManaged] = "true"
		}
		if id != "" {
			labels[LabelInstance] = id
		}
		v := &volume.Volume{Labels: labels}
		if size != nil {
			v.UsageData = &volume.UsageData{Size: *size, RefCount: 1}
		}
		return v
	}
	sz := func(n int64) *int64 { return &n }
	t.Run("keeps only managed volumes with an instance label and a size of 0 or more", func(t *testing.T) {
		a, b, c, d, e, g := newUUID(), newUUID(), newUUID(), newUUID(), newUUID(), newUUID()
		f := newFake()
		f.du.Volumes = []*volume.Volume{
			vol(a, true, sz(5_242_880)), vol(b, true, sz(0)), vol(c, true, sz(-1)), vol(d, true, nil),
			vol(e, false, sz(100)), vol("", true, sz(100)), vol(toUpper(g), true, sz(7)),
		}
		usage, err := NewDocker(f, quiet()).VolumeUsage(ctx)
		if err != nil || len(usage) != 3 || usage[a] != 5_242_880 || usage[b] != 0 || usage[g] != 7 {
			t.Fatalf("usage %v err %v", usage, err)
		}
	})
	t.Run("returns an empty map when Docker reports no volumes (null)", func(t *testing.T) {
		usage, err := NewDocker(newFake(), quiet()).VolumeUsage(ctx)
		if err != nil || len(usage) != 0 {
			t.Fatalf("usage %v err %v", usage, err)
		}
	})
	t.Run("asks Docker for volumes only", func(t *testing.T) {
		f := newFake()
		_, _ = NewDocker(f, quiet()).VolumeUsage(ctx)
		if len(f.duCalls) != 1 || len(f.duCalls[0].Types) != 1 || f.duCalls[0].Types[0] != types.VolumeObject {
			t.Fatalf("calls %+v", f.duCalls)
		}
	})
}

func toUpper(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'a' && c <= 'z' {
			b[i] = c - 32
		}
	}
	return string(b)
}

// --- Port of test/unit/runtime-health.test.ts ---

func runningAt(port int) *container.InspectResponse {
	return &container.InspectResponse{
		ContainerJSONBase: &container.ContainerJSONBase{State: &container.State{Status: "running", Running: true, StartedAt: "2026-11-19T10:00:00.000000000Z"}},
		//lint:ignore SA1019 in SDK v28 Ports exists only in NetworkSettingsBase (it moves to NetworkSettings in v29)
		NetworkSettings: &container.NetworkSettings{NetworkSettingsBase: container.NetworkSettingsBase{
			Ports: nat.PortMap{"8642/tcp": []nat.PortBinding{{HostIP: "127.0.0.1", HostPort: strconv.Itoa(port)}}},
		}},
	}
}

func TestCheckHealth(t *testing.T) {
	ctx := context.Background()
	serve := func(t *testing.T, status int, seen *string) int {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/api/sessions" {
				t.Errorf("path %s", r.URL.Path)
			}
			if seen != nil {
				*seen = r.Header.Get("Authorization")
			}
			w.WriteHeader(status)
		}))
		t.Cleanup(srv.Close)
		_, p, _ := net.SplitHostPort(srv.Listener.Addr().String())
		port, _ := strconv.Atoi(p)
		return port
	}
	check := func(t *testing.T, status int, key string) Health {
		f := newFake()
		f.inspect = runningAt(serve(t, status, nil))
		return NewDocker(f, quiet()).CheckHealth(ctx, newUUID(), key)
	}
	t.Run("is ok on 200 when a key is supplied", func(t *testing.T) {
		if h := check(t, 200, "k"); !h.OK || h.Detail != "HTTP 200" {
			t.Fatalf("%+v", h)
		}
	})
	t.Run(`is not ok on 401 when a key is supplied, with detail "auth rejected"`, func(t *testing.T) {
		if h := check(t, 401, "k"); h.OK || h.Detail != AuthRejectedDetail {
			t.Fatalf("%+v", h)
		}
	})
	t.Run("is still ok on 401 when no key is supplied (daemon alive)", func(t *testing.T) {
		if h := check(t, 401, ""); !h.OK {
			t.Fatalf("%+v", h)
		}
	})
	t.Run("is ok on 200 when no key is supplied", func(t *testing.T) {
		if h := check(t, 200, ""); !h.OK {
			t.Fatalf("%+v", h)
		}
	})
	t.Run("sends the Bearer header when a key is supplied", func(t *testing.T) {
		var seen string
		f := newFake()
		f.inspect = runningAt(serve(t, 200, &seen))
		NewDocker(f, quiet()).CheckHealth(ctx, newUUID(), "the-key")
		if seen != "Bearer the-key" {
			t.Fatalf("header %q", seen)
		}
	})
	t.Run("returns not ok without calling fetch when the container is not running", func(t *testing.T) {
		called := false
		srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
		defer srv.Close()
		f := newFake() // ContainerInspect answers 404: absent
		h := NewDocker(f, quiet()).CheckHealth(ctx, newUUID(), "k")
		if h.OK || called || h.Detail != "runtime not running (absent)" {
			t.Fatalf("%+v called=%v", h, called)
		}
	})
}

func TestWithHealthTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		w.WriteHeader(200)
	}))
	defer srv.Close()
	_, p, _ := net.SplitHostPort(srv.Listener.Addr().String())
	port, _ := strconv.Atoi(p)
	f := newFake()
	f.inspect = runningAt(port)
	if h := NewDocker(f, quiet()).WithHealthTimeout(100*time.Millisecond).CheckHealth(context.Background(), newUUID(), "k"); h.OK || h.Detail != "timeout" {
		t.Fatalf("short timeout: %+v", h)
	}
	if h := NewDocker(f, quiet()).WithHealthTimeout(2*time.Second).CheckHealth(context.Background(), newUUID(), "k"); !h.OK {
		t.Fatalf("long timeout: %+v", h)
	}
}

// TestDaemonStallReturnsUnavailable: a daemon that accepts the connection and never answers (Review Focus 1)
// gives apperr.RuntimeUnavailable as soon as the caller's deadline passes, not a hang.
func TestDaemonStallReturnsUnavailable(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			defer c.Close() // hold it open, say nothing
		}
	}()
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://"+ln.Addr().String()), client.WithVersion("1.47"))
	if err != nil {
		t.Fatal(err)
	}
	m := NewDocker(cli, quiet())
	for name, call := range map[string]func(context.Context) error{
		"inspect": func(ctx context.Context) error { _, err := m.Inspect(ctx, newUUID()); return err },
		"ensure":  func(ctx context.Context) error { _, err := m.Ensure(ctx, unitSpec("off", "off")); return err },
		"usage":   func(ctx context.Context) error { _, err := m.VolumeUsage(ctx); return err },
		"remove":  func(ctx context.Context) error { return m.Remove(ctx, newUUID(), true) },
	} {
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		start := time.Now()
		err := call(ctx)
		cancel()
		if !errors.Is(err, apperr.RuntimeUnavailable) || time.Since(start) > time.Second {
			t.Errorf("%s: err %v after %s", name, err, time.Since(start))
		}
	}
}

// TestTranslateNeverLeaksDockerText: SDK errors become a fixed message with a status, or RuntimeUnavailable.
func TestTranslateNeverLeaksDockerText(t *testing.T) {
	if err := translate(statusErr{500, "env SECRET=x at /var/lib/docker"}); err.Error() != "Docker operation failed (status 500)" {
		t.Fatalf("%v", err)
	}
	if err := translate(errors.New("weird")); err.Error() != "Docker operation failed (status n/a)" {
		t.Fatalf("%v", err)
	}
	if err := translate(apperr.VolumeQuotaMissing); !errors.Is(err, apperr.VolumeQuotaMissing) {
		t.Fatalf("typed errors pass through: %v", err)
	}
	if err := translate(context.DeadlineExceeded); !errors.Is(err, apperr.RuntimeUnavailable) {
		t.Fatalf("a timeout is runtime_unavailable: %v", err)
	}
	if err := translate(fmt.Errorf("dial: %w", io.ErrUnexpectedEOF)); errors.Is(err, apperr.RuntimeUnavailable) {
		t.Fatalf("an unrelated error is not unavailable: %v", err)
	}
}

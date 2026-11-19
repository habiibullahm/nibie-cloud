package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/system"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

const (
	canaryGateway   = "172.31.0.1"
	canaryPrivateIP = "192.0.2.77"
	canaryImage     = "canary@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

// startupFake is an in-memory Docker for the startup checks, recording every call.
type startupFake struct {
	calls      []string
	networks   []network.CreateOptions
	netNames   []string
	containers []struct {
		cfg  *container.Config
		host *container.HostConfig
	}
	output        string
	gateway       string
	statusCode    int64
	imageMissing  bool
	noGateway     bool
	createErr     error
	startErr      error
	waitErr       error
	removeErr     error
	volumeMissing bool
	volInspectErr error
	volCreateErr  error
	volOpts       map[string]string
	volCreated    []volume.CreateOptions
	volRemoved    []string
	infoRuntimes  map[string]system.RuntimeWithStatus
	infoCalls     int
}

func (f *startupFake) ImageInspect(context.Context, string, ...client.ImageInspectOption) (image.InspectResponse, error) {
	f.calls = append(f.calls, "image.inspect")
	if f.imageMissing {
		return image.InspectResponse{}, statusErr{404, "no such image"}
	}
	return image.InspectResponse{}, nil
}

func (f *startupFake) NetworkCreate(_ context.Context, name string, o network.CreateOptions) (network.CreateResponse, error) {
	f.calls = append(f.calls, "network.create")
	f.networks, f.netNames = append(f.networks, o), append(f.netNames, name)
	return network.CreateResponse{}, nil
}

func (f *startupFake) NetworkInspect(context.Context, string, network.InspectOptions) (network.Inspect, error) {
	n := network.Inspect{}
	if !f.noGateway {
		gw := canaryGateway
		if f.gateway != "" {
			gw = f.gateway
		}
		n.IPAM.Config = []network.IPAMConfig{{Gateway: gw}}
	}
	return n, nil
}

func (f *startupFake) NetworkRemove(context.Context, string) error {
	f.calls = append(f.calls, "network.remove")
	return nil
}

func (f *startupFake) ContainerCreate(_ context.Context, cfg *container.Config, host *container.HostConfig, _ *network.NetworkingConfig, _ *ocispec.Platform, _ string) (container.CreateResponse, error) {
	f.calls = append(f.calls, "container.create")
	if f.createErr != nil {
		return container.CreateResponse{}, f.createErr
	}
	f.containers = append(f.containers, struct {
		cfg  *container.Config
		host *container.HostConfig
	}{cfg, host})
	return container.CreateResponse{ID: "c1"}, nil
}

func (f *startupFake) ContainerStart(context.Context, string, container.StartOptions) error {
	f.calls = append(f.calls, "container.start")
	return f.startErr
}

func (f *startupFake) ContainerWait(context.Context, string, container.WaitCondition) (<-chan container.WaitResponse, <-chan error) {
	res, errc := make(chan container.WaitResponse, 1), make(chan error, 1)
	if f.waitErr != nil {
		errc <- f.waitErr
	} else {
		res <- container.WaitResponse{StatusCode: f.statusCode}
	}
	return res, errc
}

func (f *startupFake) ContainerLogs(context.Context, string, container.LogsOptions) (io.ReadCloser, error) {
	out := f.output
	if out == "" && f.statusCode == 0 {
		out = "gateway=blocked\nprivate=blocked\nmetadata=blocked\n"
	}
	if f.output == "-" {
		out = ""
	}
	return io.NopCloser(strings.NewReader(out)), nil
}

func (f *startupFake) ContainerRemove(context.Context, string, container.RemoveOptions) error {
	f.calls = append(f.calls, "container.remove")
	return f.removeErr
}

func (f *startupFake) VolumeInspect(_ context.Context, name string) (volume.Volume, error) {
	f.calls = append(f.calls, "volume.inspect")
	switch {
	case f.volumeMissing:
		return volume.Volume{}, statusErr{404, "no such volume"}
	case f.volInspectErr != nil:
		return volume.Volume{}, f.volInspectErr
	}
	opts := f.volOpts
	if opts == nil && len(f.volCreated) > 0 {
		opts = f.volCreated[len(f.volCreated)-1].DriverOpts
	}
	return volume.Volume{Name: name, Options: opts}, nil
}

func (f *startupFake) VolumeCreate(_ context.Context, o volume.CreateOptions) (volume.Volume, error) {
	f.calls = append(f.calls, "volume.create")
	if f.volCreateErr != nil {
		return volume.Volume{}, f.volCreateErr
	}
	f.volCreated = append(f.volCreated, o)
	return volume.Volume{Name: o.Name}, nil
}

func (f *startupFake) VolumeRemove(_ context.Context, name string, _ bool) error {
	f.volRemoved = append(f.volRemoved, name)
	return nil
}

func (f *startupFake) Info(context.Context) (system.Info, error) {
	f.infoCalls++
	return system.Info{Runtimes: f.infoRuntimes}, nil
}

type listenRec struct {
	host   string
	port   int
	closed bool
}

func fakeListen(recs *[]*listenRec) ListenFunc {
	next := 40_000
	return func(host string) (int, func() error, error) {
		next++
		r := &listenRec{host: host, port: next}
		*recs = append(*recs, r)
		return r.port, func() error { r.closed = true; return nil }, nil
	}
}

func capture() (*slog.Logger, *bytes.Buffer) {
	var buf bytes.Buffer
	return slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})), &buf
}

//lint:ignore ST1008 test helper: (err, logs) reads naturally at the call sites
func runCanary(f *startupFake, privateIP, runtime string, recs *[]*listenRec) (error, string) {
	log, buf := capture()
	err := RunEgressCanary(context.Background(), f, canaryImage, privateIP, runtime, fakeListen(recs), log)
	return err, buf.String()
}

type probe struct {
	check, host string
	port        int
}

func probesOf(f *startupFake) []probe {
	args := f.containers[0].cfg.Cmd[4:] // sh -c <script> canary <triples...>
	var out []probe
	for i := 0; i+2 < len(args); i += 3 {
		p, _ := strconv.Atoi(args[i+2])
		out = append(out, probe{args[i], args[i+1], p})
	}
	return out
}

func checks(ps []probe) []string {
	var out []string
	for _, p := range ps {
		out = append(out, p.check)
	}
	return out
}

func allClosed(recs []*listenRec) bool {
	for _, r := range recs {
		if !r.closed {
			return false
		}
	}
	return true
}

// --- Port of test/unit/egress-canary.test.ts ---

func TestEvaluateCanary(t *testing.T) {
	t.Run("passes when nothing connected", func(t *testing.T) {
		if err := evaluateCanary([]canaryResult{{"gateway", false}, {"private", false}, {"metadata", false}}); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("throws EgressPolicyError naming the first connected check only", func(t *testing.T) {
		err := evaluateCanary([]canaryResult{{"gateway", false}, {"metadata", true}, {"private", true}})
		var pe *EgressPolicyError
		if !errors.As(err, &pe) || !strings.Contains(err.Error(), "metadata") || strings.Contains(err.Error(), "private") {
			t.Fatalf("err %v", err)
		}
	})
}

func TestRunEgressCanary(t *testing.T) {
	isCanaryErr := func(err error) bool { var ce *EgressCanaryError; return errors.As(err, &ce) }
	isPolicyErr := func(err error) bool { var pe *EgressPolicyError; return errors.As(err, &pe) }
	t.Run("resolves when no probe connects", func(t *testing.T) {
		var recs []*listenRec
		if err, _ := runCanary(&startupFake{}, "", "", &recs); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("rejects with EgressPolicyError naming gateway only when the gateway probe connects", func(t *testing.T) {
		var recs []*listenRec
		err, _ := runCanary(&startupFake{output: "gateway=connected\nmetadata=blocked\n"}, "", "", &recs)
		if !isPolicyErr(err) || !strings.Contains(err.Error(), "gateway") || strings.Contains(err.Error(), "metadata") {
			t.Fatalf("err %v", err)
		}
	})
	t.Run("adds the private probe only when a private IP is configured", func(t *testing.T) {
		var r1, r2 []*listenRec
		without := &startupFake{output: "gateway=blocked\nmetadata=blocked\n"}
		_, _ = runCanary(without, "", "", &r1)
		if got := checks(probesOf(without)); !slices.Equal(got, []string{"gateway", "metadata"}) || len(r1) != 1 || r1[0].host != canaryGateway {
			t.Fatalf("checks %v listens %v", got, r1)
		}
		with := &startupFake{}
		_, _ = runCanary(with, canaryPrivateIP, "", &r2)
		if got := checks(probesOf(with)); !slices.Equal(got, []string{"gateway", "private", "metadata"}) {
			t.Fatalf("checks %v", got)
		}
	})
	t.Run("opens a listener on the gateway and on the private IP and probes those exact ports", func(t *testing.T) {
		var recs []*listenRec
		f := &startupFake{}
		_, _ = runCanary(f, canaryPrivateIP, "", &recs)
		p := probesOf(f)
		if len(recs) != 2 || recs[0].host != canaryGateway || recs[1].host != canaryPrivateIP ||
			p[0] != (probe{"gateway", canaryGateway, recs[0].port}) || p[1] != (probe{"private", canaryPrivateIP, recs[1].port}) {
			t.Fatalf("recs %v probes %v", recs, p)
		}
	})
	t.Run("the metadata probe targets 169.254.169.254:80 and never gets a listener", func(t *testing.T) {
		var recs []*listenRec
		f := &startupFake{output: "gateway=blocked\nmetadata=blocked\n"}
		_, _ = runCanary(f, "", "", &recs)
		p := probesOf(f)
		if p[len(p)-1] != (probe{"metadata", "169.254.169.254", 80}) {
			t.Fatalf("probes %v", p)
		}
		for _, r := range recs {
			if r.host == "169.254.169.254" {
				t.Fatal("a listener on the metadata address")
			}
		}
	})
	t.Run("closes the listeners, removes the container and removes the network when everything passes", func(t *testing.T) {
		var recs []*listenRec
		f := &startupFake{}
		_, _ = runCanary(f, canaryPrivateIP, "", &recs)
		if !allClosed(recs) || !slices.Contains(f.calls, "container.remove") || !slices.Contains(f.calls, "network.remove") {
			t.Fatalf("calls %v", f.calls)
		}
	})
	t.Run("does the same cleanup when a probe connects", func(t *testing.T) {
		var recs []*listenRec
		f := &startupFake{output: "gateway=connected\n"}
		_, _ = runCanary(f, canaryPrivateIP, "", &recs)
		if !allClosed(recs) || !slices.Contains(f.calls, "container.remove") || !slices.Contains(f.calls, "network.remove") {
			t.Fatalf("calls %v", f.calls)
		}
	})
	t.Run("does the same cleanup, and rejects with a different error, when the container cannot be created", func(t *testing.T) {
		var recs []*listenRec
		f := &startupFake{createErr: errors.New("boom: /var/lib/docker/secret")}
		err, _ := runCanary(f, "", "", &recs)
		if !isCanaryErr(err) || isPolicyErr(err) || strings.Contains(err.Error(), "/var/lib") || !allClosed(recs) || !slices.Contains(f.calls, "network.remove") {
			t.Fatalf("err %v calls %v", err, f.calls)
		}
	})
	t.Run("does the same cleanup, and rejects with a different error, when the image is missing", func(t *testing.T) {
		var recs []*listenRec
		f := &startupFake{imageMissing: true}
		err, _ := runCanary(f, "", "", &recs)
		created, removed := 0, 0
		for _, c := range f.calls {
			created += map[bool]int{true: 1}[c == "network.create"]
			removed += map[bool]int{true: 1}[c == "network.remove"]
		}
		if !isCanaryErr(err) || isPolicyErr(err) || slices.Contains(f.calls, "container.create") || created != removed {
			t.Fatalf("err %v calls %v", err, f.calls)
		}
	})
	t.Run("cleans up and rejects with EgressCanaryError when waiting for the container fails", func(t *testing.T) {
		var recs []*listenRec
		f := &startupFake{waitErr: errors.New("daemon went away")}
		err, _ := runCanary(f, "", "", &recs)
		if !isCanaryErr(err) || !slices.Contains(f.calls, "container.remove") || !slices.Contains(f.calls, "network.remove") {
			t.Fatalf("err %v calls %v", err, f.calls)
		}
	})
	t.Run("cannot pass silently: a missing result, a script error or a non-zero exit is a canary failure, not a pass", func(t *testing.T) {
		for _, f := range []*startupFake{
			{output: "gateway=blocked\n"},
			{output: "error=nc_missing\n", statusCode: 127},
			{output: "gateway=blocked\nmetadata=blocked\n", statusCode: 1},
			{output: "-"},
		} {
			var recs []*listenRec
			if err, _ := runCanary(f, "", "", &recs); !isCanaryErr(err) {
				t.Errorf("%q exit %d: err %v", f.output, f.statusCode, err)
			}
		}
	})
	t.Run("rejects with EgressCanaryError when the network has no gateway", func(t *testing.T) {
		var recs []*listenRec
		f := &startupFake{noGateway: true}
		if err, _ := runCanary(f, "", "", &recs); !isCanaryErr(err) || !slices.Contains(f.calls, "network.remove") {
			t.Fatalf("err %v calls %v", err, f.calls)
		}
	})
	t.Run("uses a network built by buildNetworkConfig with an hn bridge name so the rules match it", func(t *testing.T) {
		var recs []*listenRec
		f := &startupFake{output: "gateway=blocked\nmetadata=blocked\n"}
		_, _ = runCanary(f, "", "", &recs)
		if len(f.networks) != 1 || f.networks[0].EnableIPv6 == nil || *f.networks[0].EnableIPv6 || !regexp.MustCompile(`^hn[0-9a-f]{12}$`).MatchString(f.networks[0].Options[BridgeNameOption]) {
			t.Fatalf("networks %+v", f.networks)
		}
	})
	t.Run("runs the canary with CapDrop ALL, a read-only rootfs, no volumes and small memory and pids limits", func(t *testing.T) {
		var recs []*listenRec
		f := &startupFake{output: "gateway=blocked\nmetadata=blocked\n"}
		_, _ = runCanary(f, "", "", &recs)
		c, h := f.containers[0].cfg, f.containers[0].host
		if c.Image != canaryImage || !slices.Equal([]string(h.CapDrop), []string{"ALL"}) || !h.ReadonlyRootfs || len(h.Binds) != 0 || len(h.Mounts) != 0 || len(c.Volumes) != 0 ||
			h.Memory > 64<<20 || h.PidsLimit == nil || *h.PidsLimit > 64 || !slices.Contains(h.SecurityOpt, "no-new-privileges") || string(h.NetworkMode) != f.netNames[0] {
			t.Fatalf("config %+v host %+v", c, h)
		}
	})
	t.Run("runs the canary under the configured OCI runtime so it tests the tenants path", func(t *testing.T) {
		for rt, wantPids := range map[string]int64{"runsc": 256, "runc": 32, "": 32} {
			var recs []*listenRec
			f := &startupFake{output: "gateway=blocked\nmetadata=blocked\n"}
			_, _ = runCanary(f, "", rt, &recs)
			if h := f.containers[0].host; h.Runtime != rt || *h.PidsLimit != wantPids {
				t.Errorf("runtime %q: got %q pids %d", rt, h.Runtime, *h.PidsLimit)
			}
		}
	})
	t.Run("logs a cleanup failure by reason only (a leaked network must not be silent) and still tries the network", func(t *testing.T) {
		var recs []*listenRec
		f := &startupFake{removeErr: errors.New("cannot remove " + canaryGateway)}
		_, logs := runCanary(f, "", "", &recs)
		if !strings.Contains(logs, "container_remove_failed") || strings.Contains(logs, canaryGateway) || !slices.Contains(f.calls, "network.remove") {
			t.Fatalf("logs %s calls %v", logs, f.calls)
		}
	})
	t.Run("error messages and logs never contain the probe addresses", func(t *testing.T) {
		var r1, r2, r3 []*listenRec
		e1, l1 := runCanary(&startupFake{output: "gateway=connected\n"}, canaryPrivateIP, "", &r1)
		e2, l2 := runCanary(&startupFake{createErr: errors.New("dial " + canaryGateway + " " + canaryPrivateIP)}, canaryPrivateIP, "", &r2)
		_, l3 := runCanary(&startupFake{}, canaryPrivateIP, "", &r3)
		all := strings.Join([]string{e1.Error(), e2.Error(), l1, l2, l3}, "\n")
		for _, secret := range []string{canaryGateway, canaryPrivateIP, "169.254.169.254"} {
			if strings.Contains(all, secret) {
				t.Errorf("%s leaked", secret)
			}
		}
	})
}

// TestCanaryCleansUpOnEveryFailure (Review Focus 5): whatever step fails, every listener is closed and every
// container and network created is removed.
func TestCanaryCleansUpOnEveryFailure(t *testing.T) {
	for name, f := range map[string]*startupFake{
		"image inspect":    {imageMissing: true},
		"no gateway":       {noGateway: true},
		"container create": {createErr: errors.New("x")},
		"container start":  {startErr: errors.New("x")},
		"wait":             {waitErr: context.DeadlineExceeded},
		"bad output":       {output: "garbage\n"},
		"policy hit":       {output: "gateway=connected\nprivate=blocked\nmetadata=blocked\n"},
	} {
		var recs []*listenRec
		_, _ = runCanary(f, canaryPrivateIP, "", &recs)
		count := func(c string) int {
			n := 0
			for _, x := range f.calls {
				if x == c {
					n++
				}
			}
			return n
		}
		if !allClosed(recs) || count("network.create") != count("network.remove") || count("container.create") > count("container.remove")+boolInt(f.createErr != nil) {
			t.Errorf("%s: listeners closed %v, calls %v", name, allClosed(recs), f.calls)
		}
	}
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// TestCanaryAndSeedGolden: the canary and DNS seed requests equal the ones the Node code sends.
func TestCanaryAndSeedGolden(t *testing.T) {
	g := loadGolden(t)
	var scripts struct{ Canary, DNSSeed string }
	if err := json.Unmarshal(g["scripts"], &scripts); err != nil {
		t.Fatal(err)
	}
	if CanaryScript != scripts.Canary || DNSResolvSeedScript != scripts.DNSSeed {
		t.Fatal("scripts differ from Node's")
	}
	for _, c := range cases[struct {
		Name, Runtime, PrivateIP string
		Network, Container       map[string]any
	}](t, g, "canary") {
		t.Run("canary-"+c.Name, func(t *testing.T) {
			f := &startupFake{gateway: "172.30.0.1"} // the generator's fake gateway
			log, _ := capture()
			n := 40_000
			listen := func(string) (int, func() error, error) { n++; return n, func() error { return nil }, nil }
			if err := RunEgressCanary(context.Background(), f, "busybox@sha256:"+strings.Repeat("a", 64), c.PrivateIP, c.Runtime, listen, log); err != nil {
				t.Fatal(err)
			}
			id := strings.TrimPrefix(f.netNames[0], "hermes-net-")
			anon := func(v any) map[string]any {
				b, _ := json.Marshal(v)
				s := strings.ReplaceAll(string(b), id, "<canary-id>")
				s = strings.ReplaceAll(s, strings.ReplaceAll(id, "-", "")[:12], "<canary-bridge>")
				var m map[string]any
				_ = json.Unmarshal([]byte(s), &m)
				return m
			}
			wantNet := c.Network
			if wantNet["Name"] != "hermes-net-<canary-id>" {
				t.Fatalf("golden network name %v", wantNet["Name"])
			}
			delete(wantNet, "Name")
			assertEngineEqual(t, wantNet, anon(f.networks[0]))
			host := c.Container["HostConfig"].(map[string]any)
			delete(c.Container, "HostConfig")
			assertEngineEqual(t, c.Container, anon(f.containers[0].cfg))
			assertEngineEqual(t, host, anon(f.containers[0].host))
		})
	}
	for _, c := range cases[struct {
		Name, Runtime string
		Container     map[string]any
	}](t, g, "dnsSeed") {
		t.Run("dns-"+c.Name, func(t *testing.T) {
			f := &startupFake{}
			if err := EnsureDNSResolvConf(context.Background(), f, "busybox@sha256:"+strings.Repeat("a", 64), []string{"192.0.2.53", "198.51.100.53"}, c.Runtime, quiet()); err != nil {
				t.Fatal(err)
			}
			host := c.Container["HostConfig"].(map[string]any)
			delete(c.Container, "HostConfig")
			assertEngineEqual(t, c.Container, f.containers[0].cfg)
			assertEngineEqual(t, host, f.containers[0].host)
		})
	}
}

// --- The canary script itself, under a real sh (port of the 'canary script' tests) ---

func TestCanaryScript(t *testing.T) {
	if _, err := os.Stat("/bin/sh"); err != nil {
		t.Skip("no /bin/sh")
	}
	work := t.TempDir()
	sh := func(path string, args ...string) (string, int) {
		cmd := exec.Command("/bin/sh", append([]string{"-c", CanaryScript, "canary"}, args...)...)
		cmd.Env = []string{"PATH=" + path}
		out, _ := cmd.Output()
		return string(out), cmd.ProcessState.ExitCode()
	}
	t.Run(`reports "blocked" for a closed port and "connected" for an open one, with a working nc`, func(t *testing.T) {
		if _, err := exec.LookPath("nc"); err != nil {
			t.Skip("nc is not installed here")
		}
		open, _ := net.Listen("tcp", "127.0.0.1:0")
		defer open.Close()
		go func() {
			for {
				c, err := open.Accept()
				if err != nil {
					return
				}
				c.Close()
			}
		}()
		closed, _ := net.Listen("tcp", "127.0.0.1:0")
		closedPort := closed.Addr().(*net.TCPAddr).Port
		closed.Close()
		out, code := sh(os.Getenv("PATH"), "gateway", "127.0.0.1", strconv.Itoa(open.Addr().(*net.TCPAddr).Port), "private", "127.0.0.1", strconv.Itoa(closedPort))
		if !strings.Contains(out, "gateway=connected") || !strings.Contains(out, "private=blocked") || code != 0 {
			t.Fatalf("%d %s", code, out)
		}
	})
	t.Run("fails with error=nc_missing and no probe lines when nc is absent", func(t *testing.T) {
		empty := filepath.Join(work, "empty")
		_ = os.Mkdir(empty, 0o755)
		out, code := sh(empty, "gateway", "127.0.0.1", "1")
		if !strings.Contains(out, "error=nc_missing") || regexp.MustCompile(`=(blocked|connected)`).MatchString(out) || code != 127 {
			t.Fatalf("%d %s", code, out)
		}
	})
	t.Run(`fails with error=nc_unusable and never prints "blocked" when nc cannot do a loopback connect (positive control)`, func(t *testing.T) {
		bin := filepath.Join(work, "bin")
		_ = os.Mkdir(bin, 0o755)
		_ = os.WriteFile(filepath.Join(bin, "nc"), []byte("#!/bin/sh\nexit 1\n"), 0o755)
		out, code := sh(bin+":/usr/bin:/bin", "gateway", "127.0.0.1", "1", "metadata", "169.254.169.254", "80")
		if !strings.Contains(out, "error=nc_unusable") || regexp.MustCompile(`=(blocked|connected)`).MatchString(out) || code == 0 {
			t.Fatalf("%d %s", code, out)
		}
	})
}

// --- Port of test/unit/dns-resolv-conf.test.ts ---

func TestEnsureDNSResolvConf(t *testing.T) {
	ctx := context.Background()
	//lint:ignore ST1008 test helper: (err, logs) reads naturally at the call sites
	run := func(f *startupFake, resolvers []string, runtime string) (error, string) {
		log, buf := capture()
		return EnsureDNSResolvConf(ctx, f, canaryImage, resolvers, runtime, log), buf.String()
	}
	two := []string{"1.1.1.1", "9.9.9.9"}
	isSeedErr := func(err error) bool { var de *DNSResolvConfError; return errors.As(err, &de) }
	t.Run("does nothing when there are no resolvers", func(t *testing.T) {
		f := &startupFake{}
		if err, _ := run(f, nil, ""); err != nil || len(f.calls) != 0 {
			t.Fatalf("%v %v", err, f.calls)
		}
	})
	t.Run("creates the volume when missing, then seeds it with a container", func(t *testing.T) {
		f := &startupFake{volumeMissing: true}
		_, _ = run(f, two, "")
		if !slices.Equal(f.calls, []string{"volume.inspect", "volume.create", "container.create", "container.start", "container.remove"}) {
			t.Fatalf("calls %v", f.calls)
		}
	})
	t.Run("does not recreate the volume when it already exists", func(t *testing.T) {
		f := &startupFake{}
		_, _ = run(f, two, "")
		if slices.Contains(f.calls, "volume.create") {
			t.Fatal("volume recreated")
		}
	})
	t.Run("runs the seed script with resolvers as argv, not interpolated into the script body", func(t *testing.T) {
		f := &startupFake{}
		_, _ = run(f, two, "")
		if !slices.Equal(f.containers[0].cfg.Cmd, []string{"sh", "-c", DNSResolvSeedScript, "seed", "1.1.1.1", "9.9.9.9"}) || strings.Contains(DNSResolvSeedScript, "1.1.1.1") {
			t.Fatalf("cmd %v", f.containers[0].cfg.Cmd)
		}
	})
	t.Run("mounts the shared volume at /dns, with no other binds, and drops all capabilities", func(t *testing.T) {
		f := &startupFake{}
		_, _ = run(f, two, "")
		h := f.containers[0].host
		if len(h.Mounts) != 1 || h.Mounts[0].Target != "/dns" || h.Mounts[0].Source != DNSResolvVolume || h.Mounts[0].Type != "volume" ||
			len(h.Binds) != 0 || !slices.Equal([]string(h.CapDrop), []string{"ALL"}) || !h.ReadonlyRootfs || h.NetworkMode != "none" {
			t.Fatalf("host %+v", h)
		}
	})
	t.Run("runs the seed container under the given OCI runtime, with a raised pids limit under runsc", func(t *testing.T) {
		for rt, want := range map[string]int64{"runsc": 256, "runc": 32} {
			f := &startupFake{}
			_, _ = run(f, []string{"1.1.1.1"}, rt)
			if h := f.containers[0].host; h.Runtime != rt || *h.PidsLimit != want {
				t.Errorf("%s: %q %d", rt, h.Runtime, *h.PidsLimit)
			}
		}
	})
	t.Run("always removes the seed container, even when the volume already existed", func(t *testing.T) {
		f := &startupFake{}
		_, _ = run(f, two, "")
		if !slices.Contains(f.calls, "container.remove") {
			t.Fatal("not removed")
		}
	})
	t.Run("rejects with DnsResolvConfError, not a raw Docker error, when the volume cannot be inspected", func(t *testing.T) {
		f := &startupFake{volInspectErr: statusErr{500, "daemon down"}}
		if err, _ := run(f, two, ""); !isSeedErr(err) || slices.Contains(f.calls, "container.create") {
			t.Fatalf("%v %v", err, f.calls)
		}
	})
	t.Run("rejects with DnsResolvConfError when the volume cannot be created", func(t *testing.T) {
		f := &startupFake{volumeMissing: true, volCreateErr: errors.New("boom")}
		if err, _ := run(f, two, ""); !isSeedErr(err) || slices.Contains(f.calls, "container.create") {
			t.Fatalf("%v %v", err, f.calls)
		}
	})
	t.Run("rejects with DnsResolvConfError when the container cannot be created, and still resolves without a remove call", func(t *testing.T) {
		f := &startupFake{createErr: errors.New("boom: /var/lib/docker/secret")}
		err, _ := run(f, two, "")
		if !isSeedErr(err) || strings.Contains(err.Error(), "/var/lib") || slices.Contains(f.calls, "container.remove") {
			t.Fatalf("%v %v", err, f.calls)
		}
	})
	t.Run("rejects with DnsResolvConfError and still removes the container when starting it fails", func(t *testing.T) {
		f := &startupFake{startErr: errors.New("boom")}
		if err, _ := run(f, two, ""); !isSeedErr(err) || !slices.Contains(f.calls, "container.remove") {
			t.Fatalf("%v %v", err, f.calls)
		}
	})
	t.Run("rejects with DnsResolvConfError and still removes the container when waiting fails", func(t *testing.T) {
		f := &startupFake{waitErr: errors.New("daemon went away")}
		if err, _ := run(f, two, ""); !isSeedErr(err) || !slices.Contains(f.calls, "container.remove") {
			t.Fatalf("%v %v", err, f.calls)
		}
	})
	t.Run("rejects with DnsResolvConfError when the seed script exits non-zero", func(t *testing.T) {
		f := &startupFake{statusCode: 1}
		if err, _ := run(f, two, ""); !isSeedErr(err) || !slices.Contains(f.calls, "container.remove") {
			t.Fatalf("%v %v", err, f.calls)
		}
	})
	t.Run("does not throw when removing the container fails, but logs the failure by reason only", func(t *testing.T) {
		f := &startupFake{removeErr: errors.New("cannot remove")}
		if err, logs := run(f, two, ""); err != nil || !strings.Contains(logs, "container_remove_failed") {
			t.Fatalf("%v %s", err, logs)
		}
	})
}

// --- Port of test/unit/runtime-availability.test.ts and disk-quota-check.test.ts ---

func TestAssertRuntimeAvailable(t *testing.T) {
	ctx := context.Background()
	const msg = `Docker runtime "runsc" is not available on this host`
	t.Run("never calls info for runc", func(t *testing.T) {
		f := &startupFake{}
		if err := AssertRuntimeAvailable(ctx, f, "runc"); err != nil || f.infoCalls != 0 {
			t.Fatalf("%v calls %d", err, f.infoCalls)
		}
	})
	t.Run("passes for runsc when the daemon lists it", func(t *testing.T) {
		f := &startupFake{infoRuntimes: map[string]system.RuntimeWithStatus{"runc": {}, "runsc": {}}}
		if err := AssertRuntimeAvailable(ctx, f, "runsc"); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("fails with a clear message for runsc when it is missing", func(t *testing.T) {
		f := &startupFake{infoRuntimes: map[string]system.RuntimeWithStatus{"runc": {}}}
		if err := AssertRuntimeAvailable(ctx, f, "runsc"); err == nil || err.Error() != msg {
			t.Fatalf("%v", err)
		}
	})
	t.Run("fails for runsc when the daemon reports no Runtimes at all", func(t *testing.T) {
		if err := AssertRuntimeAvailable(ctx, &startupFake{}, "runsc"); err == nil || err.Error() != msg {
			t.Fatalf("%v", err)
		}
	})
}

func TestAssertDiskQuotaSupported(t *testing.T) {
	ctx := context.Background()
	t.Run("does nothing and never calls Docker when off", func(t *testing.T) {
		f := &startupFake{}
		if err := AssertDiskQuotaSupported(ctx, f, "off"); err != nil || len(f.calls) != 0 {
			t.Fatalf("%v %v", err, f.calls)
		}
	})
	t.Run("creates and removes a 64 MB probe volume when enforce", func(t *testing.T) {
		f := &startupFake{}
		if err := AssertDiskQuotaSupported(ctx, f, "enforce"); err != nil {
			t.Fatal(err)
		}
		c := f.volCreated[0]
		if c.Driver != "local" || c.DriverOpts["size"] != "64m" || !regexp.MustCompile(`^hermes-quota-probe-[0-9a-f-]{36}$`).MatchString(c.Name) || !slices.Equal(f.volRemoved, []string{c.Name}) {
			t.Fatalf("created %+v removed %v", c, f.volRemoved)
		}
	})
	t.Run("removes the probe volume even when creation succeeds but inspection shows no quota", func(t *testing.T) {
		f := &startupFake{volOpts: map[string]string{}}
		if err := AssertDiskQuotaSupported(ctx, f, "enforce"); err == nil || !strings.Contains(err.Error(), "HERMES_DISK_QUOTA") || len(f.volRemoved) != 1 {
			t.Fatalf("%v removed %v", err, f.volRemoved)
		}
	})
	t.Run("fails with a message naming HERMES_DISK_QUOTA when Docker rejects the size option", func(t *testing.T) {
		f := &startupFake{volCreateErr: statusErr{400, "(HTTP code 400) create x: quota size requested but no quota support"}}
		err := AssertDiskQuotaSupported(ctx, f, "enforce")
		if err == nil || !strings.Contains(err.Error(), "HERMES_DISK_QUOTA") || strings.Contains(err.Error(), "(HTTP code") {
			t.Fatalf("%v", err)
		}
	})
	t.Run("fails with a message naming HERMES_DISK_QUOTA when Docker is unreachable", func(t *testing.T) {
		f := &startupFake{volCreateErr: errors.New("connect ENOENT")}
		if err := AssertDiskQuotaSupported(ctx, f, "enforce"); err == nil || !strings.Contains(err.Error(), "HERMES_DISK_QUOTA") {
			t.Fatalf("%v", err)
		}
	})
}

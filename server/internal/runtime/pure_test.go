package runtime

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/habiibullahm/nibie-cloud/server/internal/shared/apperr"
)

func TestAPIKeyGolden(t *testing.T) {
	for _, c := range cases[struct {
		Name, MasterKey, InstanceID, Key, Error string
	}](t, loadGolden(t), "apiKey") {
		got, err := DeriveAPIKey(c.MasterKey, c.InstanceID)
		if c.Error != "" {
			if err == nil || err.Error() != c.Error {
				t.Errorf("%s: err %v, want %q", c.Name, err, c.Error)
			}
			continue
		}
		if err != nil || got != c.Key {
			t.Errorf("%s: %q %v, want %q", c.Name, got, err, c.Key)
		}
	}
	// Port of api-key.test.ts: deterministic, per instance, per master key, 64 lowercase hex.
	a, _ := DeriveAPIKey("m1-master-key-xxxxxxxxxxxxxxxxxxxx", "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b")
	b, _ := DeriveAPIKey("m1-master-key-xxxxxxxxxxxxxxxxxxxx", "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5c")
	c, _ := DeriveAPIKey("m1-master-key-yyyyyyyyyyyyyyyyyyyy", "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b")
	if a == b || a == c || !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(a) {
		t.Fatalf("keys %s %s %s", a, b, c)
	}
}

func TestNamesGolden(t *testing.T) {
	for _, c := range cases[struct {
		Name, ID, Container, Volume, Network, Bridge, Error string
	}](t, loadGolden(t), "names") {
		id, err := ParseID(c.ID)
		if c.Error != "" {
			if err == nil || err.Error() != c.Error || !errors.Is(err, apperr.Validation("")) {
				t.Errorf("%s: err %v, want validation %q", c.Name, err, c.Error)
			}
			continue
		}
		if err != nil || id.ContainerName() != c.Container || id.VolumeName() != c.Volume || id.NetworkName() != c.Network || id.BridgeName() != c.Bridge {
			t.Errorf("%s: %s %s %s %s %v", c.Name, id.ContainerName(), id.VolumeName(), id.NetworkName(), id.BridgeName(), err)
		}
		if len(id.BridgeName()) != 14 {
			t.Errorf("%s: bridge name %q is not 14 characters", c.Name, id.BridgeName())
		}
	}
}

func TestNetworkConfigGolden(t *testing.T) {
	for _, c := range cases[struct {
		Name, InstanceID, TenantID, Error string
		Options                           map[string]any
	}](t, loadGolden(t), "network") {
		name, opts, err := BuildNetworkConfig(c.InstanceID, c.TenantID)
		if c.Error != "" {
			if err == nil || err.Error() != c.Error {
				t.Errorf("%s: err %v, want %q", c.Name, err, c.Error)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		if name != c.Options["Name"] {
			t.Errorf("%s: name %q, want %v", c.Name, name, c.Options["Name"])
		}
		delete(c.Options, "Name")
		t.Run(c.Name, func(t *testing.T) { assertEngineEqual(t, c.Options, opts) })
	}
}

type containerCase struct {
	Name          string          `json:"name"`
	Spec          json.RawMessage `json:"spec"`
	ContainerName string          `json:"containerName"`
	Body          map[string]any  `json:"body"`
	Error         string          `json:"error"`
}

// nodeSpec reads a Node RuntimeSpec into a Go Spec.
func nodeSpec(t *testing.T, raw json.RawMessage) Spec {
	t.Helper()
	var s struct {
		InstanceID   string             `json:"instanceId"`
		TenantID     string             `json:"tenantId"`
		Image        string             `json:"image"`
		Limits       map[string]float64 `json:"limits"`
		DiskQuota    string             `json:"diskQuota"`
		EgressPolicy string             `json:"egressPolicy"`
		Env          map[string]string  `json:"env"`
		Runtime      string             `json:"runtime"`
		DNS          []string           `json:"dns"`
		APIServerKey string             `json:"apiServerKey"`
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	return Spec{
		InstanceID: s.InstanceID, TenantID: s.TenantID, Image: s.Image, DiskQuota: s.DiskQuota, EgressPolicy: s.EgressPolicy,
		Env: s.Env, Runtime: s.Runtime, DNS: s.DNS, APIServerKey: s.APIServerKey,
		Limits: ResourceLimits{CPUMillis: int(s.Limits["cpuMillis"]), MemoryMB: int(s.Limits["memoryMb"]), Pids: int(s.Limits["pids"]), StorageMB: int(s.Limits["storageMb"])},
	}
}

func TestContainerConfigGolden(t *testing.T) {
	for _, c := range cases[containerCase](t, loadGolden(t), "container") {
		t.Run(c.Name, func(t *testing.T) {
			if c.Name == "cpu-not-integer" {
				t.Skip("Go limits are int: a fractional limit cannot reach BuildContainerConfig")
			}
			req, err := BuildContainerConfig(nodeSpec(t, c.Spec))
			if c.Error != "" {
				if err == nil || err.Error() != c.Error || !errors.Is(err, apperr.Validation("")) {
					t.Fatalf("err %v, want validation %q", err, c.Error)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if req.Name != c.ContainerName {
				t.Fatalf("name %q, want %q", req.Name, c.ContainerName)
			}
			host := c.Body["HostConfig"].(map[string]any)
			delete(c.Body, "HostConfig")
			assertEngineEqual(t, c.Body, req.Config)
			assertEngineEqual(t, host, req.Host)
		})
	}
}

// TestHardeningInvariants ports the properties hardening.test.ts states in words, on top of the golden.
func TestHardeningInvariants(t *testing.T) {
	spec := Spec{
		InstanceID: "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b", TenantID: "9e8d7c6b-5a49-4382-a170-6f5e4d3c2b1a", Image: "img:1",
		Limits: ResourceLimits{CPUMillis: 1000, MemoryMB: 1024, Pids: 256, StorageMB: 1024}, Env: map[string]string{},
	}
	req, err := BuildContainerConfig(spec)
	if err != nil {
		t.Fatal(err)
	}
	h, c := req.Host, req.Config
	if c.User != "" {
		t.Error("the container user must never be pinned (the s6 entrypoint drops to 10000 itself)")
	}
	if h.Init == nil || *h.Init {
		t.Error("Init must be explicitly false")
	}
	if len(c.Entrypoint) != 0 || !slices.Equal(c.Cmd, []string{"gateway", "run"}) {
		t.Errorf("entrypoint %v cmd %v", c.Entrypoint, c.Cmd)
	}
	if !slices.Equal(h.CapDrop, []string{"ALL"}) || !slices.Equal(h.CapAdd, S6RequiredCaps) {
		t.Errorf("caps %v %v", h.CapDrop, h.CapAdd)
	}
	if h.Privileged || !h.ReadonlyRootfs || !slices.Equal(h.SecurityOpt, []string{"no-new-privileges:true"}) {
		t.Errorf("privileged %v readonly %v securityopt %v", h.Privileged, h.ReadonlyRootfs, h.SecurityOpt)
	}
	if string(h.NetworkMode) != "hermes-net-3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b" {
		t.Errorf("network mode %q (never host)", h.NetworkMode)
	}
	if !slices.Equal(h.Binds, []string{"hermes-data-3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b:/opt/data"}) || len(h.Mounts) != 0 {
		t.Errorf("binds %v mounts %v: only the tenant volume", h.Binds, h.Mounts)
	}
	for _, b := range h.Binds {
		if strings.Contains(b, "docker.sock") || strings.HasPrefix(b, "/") {
			t.Errorf("host path or socket mounted: %s", b)
		}
	}
	if len(h.DNS) != 0 {
		t.Errorf("Dns must stay unset without resolvers, got %v", h.DNS)
	}
	spec.DNS = []string{"192.0.2.53"}
	req2, _ := BuildContainerConfig(spec)
	spec.DNS[0] = "203.0.113.1"
	if req2.Host.DNS[0] != "192.0.2.53" {
		t.Error("Dns must be a copy of the given list")
	}
	if h.LogConfig.Type != "json-file" || h.LogConfig.Config["max-size"] != "10m" || h.LogConfig.Config["max-file"] != "3" {
		t.Errorf("log config %v", h.LogConfig)
	}
	// Env that targets Docker is refused, in any case.
	spec.Env = map[string]string{"Docker_Host": "x"}
	if _, err := BuildContainerConfig(spec); err == nil {
		t.Error("DOCKER_* env must be refused")
	}
}

func TestImagePolicyGolden(t *testing.T) {
	for _, c := range cases[struct {
		Name, Image, Error string
		Production         bool
	}](t, loadGolden(t), "imagePolicy") {
		err := AssertPinnedImage(c.Image, c.Production)
		got := ""
		if err != nil {
			got = err.Error()
		}
		if got != c.Error {
			t.Errorf("%s (%q, production=%v): %q, want %q", c.Name, c.Image, c.Production, got, c.Error)
		}
	}
}

func TestVolumeQuotaGolden(t *testing.T) {
	g := loadGolden(t)
	for _, c := range cases[struct {
		Name    string
		Options map[string]string
		MB      *int `json:"mb"`
	}](t, g, "volumeQuota") {
		want := 0
		if c.MB != nil {
			want = *c.MB
		}
		if got := ReadVolumeQuotaMB(c.Options); got != want {
			t.Errorf("%s: %d, want %d", c.Name, got, want)
		}
	}
	var sized map[string]string
	if err := json.Unmarshal(g["sizedVolume"], &sized); err != nil {
		t.Fatal(err)
	}
	if got := SizedVolumeOpts(1024); !mapsEqual(got, sized) {
		t.Errorf("sized %v, want %v", got, sized)
	}
	if !IsQuotaUnsupported(errStatus{400, "quota size requested but no quota support"}) || IsQuotaUnsupported(errStatus{500, "no quota support"}) || IsQuotaUnsupported(errStatus{400, "other"}) {
		t.Error("IsQuotaUnsupported must need status 400 and the text")
	}
}

type errStatus struct {
	code int
	msg  string
}

func (e errStatus) Error() string   { return e.msg }
func (e errStatus) StatusCode() int { return e.code }

func mapsEqual(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

func TestDemuxGolden(t *testing.T) {
	for _, c := range cases[struct {
		Name        string
		InputBase64 string
		Lines       []string
	}](t, loadGolden(t), "demux") {
		in, _ := base64.StdEncoding.DecodeString(c.InputBase64)
		got := DemuxLogs(in)
		if len(got) == 0 && len(c.Lines) == 0 {
			continue
		}
		if !slices.Equal(got, c.Lines) {
			t.Errorf("%s: %q, want %q", c.Name, got, c.Lines)
		}
	}
}

func TestTarGolden(t *testing.T) {
	for _, c := range cases[struct {
		Name, File, Content, Base64, Error string
		UID, GID, Mode                     int
		Mtime                              int64
	}](t, loadGolden(t), "tar") {
		got, err := BuildTar(c.File, c.Content, c.UID, c.GID, c.Mode, time.Unix(c.Mtime, 0))
		if c.Error != "" {
			if err == nil || err.Error() != c.Error {
				t.Errorf("%s: err %v, want %q", c.Name, err, c.Error)
			}
			continue
		}
		want, _ := base64.StdEncoding.DecodeString(c.Base64)
		if err != nil || !bytes.Equal(got, want) {
			t.Errorf("%s: tar differs from Node (err %v, %d vs %d bytes)", c.Name, err, len(got), len(want))
		}
	}
}

func TestReadFirstFileGolden(t *testing.T) {
	for _, c := range cases[struct {
		Name, Base64 string
		Content      *string
	}](t, loadGolden(t), "readFirstFile") {
		in, _ := base64.StdEncoding.DecodeString(c.Base64)
		got, ok := ReadFirstFile(in)
		if (c.Content == nil) == ok || (ok && got != *c.Content) {
			t.Errorf("%s: %q %v, want %v", c.Name, got, ok, c.Content)
		}
	}
}

// failPastReader fails the test if anything reads more than limit bytes from it.
type failPastReader struct {
	t     *testing.T
	limit int
	read  int
}

func (r *failPastReader) Read(p []byte) (int, error) {
	if r.read > r.limit {
		r.t.Fatalf("read %d bytes, the cap was %d", r.read, r.limit)
	}
	n := min(len(p), 1024)
	for i := range n {
		p[i] = 'x'
	}
	r.read += n
	return n, nil
}

func TestCollectCappedStopsAtMax(t *testing.T) {
	b, err := CollectCapped(strings.NewReader("small"), 100)
	if err != nil || string(b) != "small" {
		t.Fatalf("%q %v", b, err)
	}
	r := &failPastReader{t: t, limit: 4096 + 1024}
	if _, err := CollectCapped(r, 4096); !errors.Is(err, apperr.ConfigUnreadable) {
		t.Fatalf("err %v, want ConfigUnreadable", err)
	}
	if _, err := CollectCapped(io.LimitReader(strings.NewReader(strings.Repeat("y", 10)), 10), 10); err != nil {
		t.Fatalf("exactly max bytes must be accepted: %v", err)
	}
}

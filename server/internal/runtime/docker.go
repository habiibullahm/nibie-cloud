package runtime

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/jsonmessage"
	"github.com/docker/go-connections/nat"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"

	"github.com/habiibullahm/nibie-cloud/server/internal/shared/apperr"
)

// DockerAPI is the part of the Docker Engine SDK client the manager uses. *client.Client satisfies it; tests pass
// fakes.
type DockerAPI interface {
	NetworkInspect(ctx context.Context, networkID string, options network.InspectOptions) (network.Inspect, error)
	NetworkCreate(ctx context.Context, name string, options network.CreateOptions) (network.CreateResponse, error)
	NetworkRemove(ctx context.Context, networkID string) error
	VolumeInspect(ctx context.Context, volumeID string) (volume.Volume, error)
	VolumeCreate(ctx context.Context, options volume.CreateOptions) (volume.Volume, error)
	VolumeRemove(ctx context.Context, volumeID string, force bool) error
	ContainerInspect(ctx context.Context, containerID string) (container.InspectResponse, error)
	ContainerCreate(ctx context.Context, config *container.Config, hostConfig *container.HostConfig, networkingConfig *network.NetworkingConfig, platform *ocispec.Platform, containerName string) (container.CreateResponse, error)
	ContainerStart(ctx context.Context, containerID string, options container.StartOptions) error
	ContainerStop(ctx context.Context, containerID string, options container.StopOptions) error
	ContainerRestart(ctx context.Context, containerID string, options container.StopOptions) error
	ContainerRemove(ctx context.Context, containerID string, options container.RemoveOptions) error
	ContainerLogs(ctx context.Context, containerID string, options container.LogsOptions) (io.ReadCloser, error)
	CopyFromContainer(ctx context.Context, containerID, srcPath string) (io.ReadCloser, container.PathStat, error)
	CopyToContainer(ctx context.Context, containerID, dstPath string, content io.Reader, options container.CopyToContainerOptions) error
	ImageInspect(ctx context.Context, imageID string, inspectOpts ...client.ImageInspectOption) (image.InspectResponse, error)
	ImagePull(ctx context.Context, refStr string, options image.PullOptions) (io.ReadCloser, error)
	DiskUsage(ctx context.Context, options types.DiskUsageOptions) (types.DiskUsage, error)
}

var _ DockerAPI = (*client.Client)(nil)

// Docker is the Manager on a Docker daemon (port of docker-runtime-manager.ts).
type Docker struct {
	api           DockerAPI
	log           *slog.Logger
	healthTimeout time.Duration
	http          *http.Client
}

var _ Manager = (*Docker)(nil)

// HealthTimeout bounds one health probe.
const HealthTimeout = 2 * time.Second

func NewDocker(api DockerAPI, log *slog.Logger) *Docker {
	return &Docker{api: api, log: log, healthTimeout: HealthTimeout, http: &http.Client{Timeout: HealthTimeout}}
}

// WithHealthTimeout changes how long one health probe may take (the live harness waits longer for the official
// image than the backend does).
func (d *Docker) WithHealthTimeout(t time.Duration) *Docker {
	d.healthTimeout, d.http = t, &http.Client{Timeout: t}
	return d
}

// translate turns an SDK error into what callers may see: a typed error passes through, an unreachable daemon is
// apperr.RuntimeUnavailable, anything else is a fixed message with the HTTP status. Docker's own text is never
// forwarded: it can hold env values and host paths.
func translate(err error) error {
	if err == nil {
		return nil
	}
	var typed *apperr.Error
	if errors.As(err, &typed) {
		return typed
	}
	if unreachable(err) {
		return apperr.RuntimeUnavailable
	}
	if code := statusOf(err); code != 0 {
		return fmt.Errorf("Docker operation failed (status %d)", code)
	}
	return errors.New("Docker operation failed (status n/a)")
}

func unreachable(err error) bool {
	if client.IsErrConnectionFailed(err) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	for _, e := range []error{syscall.ECONNREFUSED, syscall.ENOENT, syscall.EACCES, syscall.ECONNRESET, syscall.ETIMEDOUT, syscall.EPIPE} {
		if errors.Is(err, e) {
			return true
		}
	}
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

func (d *Docker) Ensure(ctx context.Context, s Spec) (EnsureResult, error) {
	req, err := BuildContainerConfig(s) // validates before touching Docker
	if err != nil {
		return EnsureResult{}, err
	}
	id, _ := ParseID(s.InstanceID)
	if err := d.ensureNetwork(ctx, s, id); err != nil {
		return EnsureResult{}, translate(err)
	}
	quota, err := d.ensureVolume(ctx, s, id)
	if err != nil {
		return EnsureResult{}, translate(err)
	}
	exists, err := d.containerExists(ctx, id)
	if err != nil {
		return EnsureResult{}, translate(err)
	}
	if !exists {
		if err := d.ensureImage(ctx, s.Image); err != nil {
			return EnsureResult{}, translate(err)
		}
		createdHere := true
		if _, err := d.api.ContainerCreate(ctx, req.Config, req.Host, nil, nil, req.Name); err != nil {
			if statusOf(err) != 409 { // 409: lost a race with a concurrent Ensure
				return EnsureResult{}, translate(err)
			}
			createdHere = false
		}
		if createdHere && s.Model != nil {
			if err := d.applyModel(ctx, req.Name, *s.Model); err != nil {
				// Never leave an unseeded container behind: the next Ensure would skip the seed and start it.
				_ = d.api.ContainerRemove(context.WithoutCancel(ctx), req.Name, container.RemoveOptions{Force: true})
				return EnsureResult{}, translate(err)
			}
		}
	}
	d.log.Info("runtime ensured", "instanceId", string(id))
	return EnsureResult{VolumeQuotaMB: quota}, nil
}

func (d *Docker) Recreate(ctx context.Context, s Spec) (EnsureResult, error) {
	req, err := BuildContainerConfig(s) // validate before removing anything
	if err != nil {
		return EnsureResult{}, err
	}
	if err := d.api.ContainerRemove(ctx, req.Name, container.RemoveOptions{Force: true}); err != nil && statusOf(err) != 404 {
		return EnsureResult{}, translate(err)
	}
	return d.Ensure(ctx, s)
}

func (d *Docker) AssertVolumeQuota(ctx context.Context, instanceID, mode string) error {
	if mode != "enforce" {
		return nil
	}
	id, err := ParseID(instanceID)
	if err != nil {
		return err
	}
	v, err := d.api.VolumeInspect(ctx, id.VolumeName())
	switch {
	case statusOf(err) == 404:
		return apperr.VolumeQuotaMissing
	case err != nil:
		return translate(err)
	case ReadVolumeQuotaMB(v.Options) == 0:
		return apperr.VolumeQuotaMissing
	}
	return nil
}

func (d *Docker) AssertNetworkPolicy(ctx context.Context, instanceID, mode string) error {
	if mode != "enforce" {
		return nil
	}
	id, err := ParseID(instanceID)
	if err != nil {
		return err
	}
	n, err := d.api.NetworkInspect(ctx, id.NetworkName(), network.InspectOptions{})
	switch {
	case statusOf(err) == 404:
		return apperr.NetworkPolicyMissing
	case err != nil:
		return translate(err)
	case n.Options[BridgeNameOption] != id.BridgeName():
		return apperr.NetworkPolicyMissing
	}
	return nil
}

func (d *Docker) Start(ctx context.Context, instanceID string) error {
	id, err := ParseID(instanceID)
	if err != nil {
		return err
	}
	if err := d.api.ContainerStart(ctx, id.ContainerName(), container.StartOptions{}); err != nil && statusOf(err) != 304 {
		return translate(err)
	}
	return nil
}

func (d *Docker) Stop(ctx context.Context, instanceID string, timeoutSec int) error {
	id, err := ParseID(instanceID)
	if err != nil {
		return err
	}
	err = d.api.ContainerStop(ctx, id.ContainerName(), container.StopOptions{Timeout: &timeoutSec})
	if err != nil && statusOf(err) != 304 && statusOf(err) != 404 {
		return translate(err)
	}
	return nil
}

func (d *Docker) Restart(ctx context.Context, instanceID string) error {
	id, err := ParseID(instanceID)
	if err != nil {
		return err
	}
	timeout := 10
	return translate(d.api.ContainerRestart(ctx, id.ContainerName(), container.StopOptions{Timeout: &timeout}))
}

// maxLogBytes bounds what Logs keeps: a few very long lines must not become a huge response.
const maxLogBytes = 256 << 10

func (d *Docker) Logs(ctx context.Context, instanceID string, tail int) ([]string, error) {
	id, err := ParseID(instanceID)
	if err != nil {
		return nil, err
	}
	tail = max(1, min(tail, 500))
	rc, err := d.api.ContainerLogs(ctx, id.ContainerName(), container.LogsOptions{
		ShowStdout: true, ShowStderr: true, Tail: strconv.Itoa(tail), Follow: false, Timestamps: true,
	})
	if statusOf(err) == 404 {
		return []string{}, nil
	}
	if err != nil {
		return nil, translate(err)
	}
	defer rc.Close()
	buf, err := io.ReadAll(io.LimitReader(rc, 16<<20))
	if err != nil {
		return nil, translate(err)
	}
	if len(buf) > maxLogBytes {
		buf = buf[len(buf)-maxLogBytes:]
	}
	lines := DemuxLogs(buf)
	if len(lines) > tail {
		lines = lines[len(lines)-tail:]
	}
	if lines == nil {
		lines = []string{}
	}
	return lines, nil
}

func (d *Docker) Inspect(ctx context.Context, instanceID string) (Inspection, error) {
	id, err := ParseID(instanceID)
	if err != nil {
		return Inspection{}, err
	}
	present, err := d.volumeExists(ctx, id)
	if err != nil {
		return Inspection{}, translate(err)
	}
	info, err := d.api.ContainerInspect(ctx, id.ContainerName())
	if statusOf(err) == 404 {
		return Inspection{State: StateAbsent, VolumePresent: present}, nil
	}
	if err != nil {
		return Inspection{}, translate(err)
	}
	st := &container.State{}
	if info.ContainerJSONBase != nil && info.State != nil {
		st = info.State
	}
	state := State(st.Status)
	switch state {
	case StateCreated, StateRunning, StateExited, StateRestarting, StateDead:
	default:
		state = StateExited
		if st.Running {
			state = StateRunning
		}
	}
	out := Inspection{State: state, OOMKilled: st.OOMKilled, VolumePresent: present}
	if state != StateRunning && state != StateCreated {
		code := st.ExitCode
		out.ExitCode = &code
	}
	if st.StartedAt != "" && !strings.HasPrefix(st.StartedAt, "0001") {
		if t, err := time.Parse(time.RFC3339Nano, st.StartedAt); err == nil {
			out.StartedAt = &t
		}
	}
	if state == StateRunning && info.NetworkSettings != nil {
		if b := info.NetworkSettings.Ports[containerPortKey()]; len(b) > 0 {
			out.HostPort, _ = strconv.Atoi(b[0].HostPort)
		}
	}
	return out, nil
}

func (d *Docker) CheckHealth(ctx context.Context, instanceID, apiServerKey string) Health {
	i, err := d.Inspect(ctx, instanceID)
	if err != nil {
		return Health{Detail: "inspect failed"}
	}
	if i.State != StateRunning || i.HostPort == 0 {
		return Health{Detail: fmt.Sprintf("runtime not running (%s)", i.State)}
	}
	t0 := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/api/sessions", i.HostPort), nil)
	if err != nil {
		return Health{Detail: "connection failed"}
	}
	if apiServerKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiServerKey)
	}
	res, err := d.http.Do(req)
	latency := time.Since(t0).Milliseconds()
	if err != nil {
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			return Health{LatencyMs: latency, Detail: "timeout"}
		}
		return Health{LatencyMs: latency, Detail: "connection failed"}
	}
	_ = res.Body.Close()
	detail := fmt.Sprintf("HTTP %d", res.StatusCode)
	if apiServerKey != "" {
		// With a key, only an authenticated 200 is ready; 401 means the gateway rejected our key.
		if res.StatusCode == 401 {
			detail = AuthRejectedDetail
		}
		return Health{OK: res.StatusCode == 200, LatencyMs: latency, Detail: detail}
	}
	// Without a key, 200 or 401 (gateway alive and enforcing auth) confirms the daemon is up.
	return Health{OK: res.StatusCode == 200 || res.StatusCode == 401, LatencyMs: latency, Detail: detail}
}

func (d *Docker) Remove(ctx context.Context, instanceID string, deleteVolume bool) error {
	id, err := ParseID(instanceID)
	if err != nil {
		return err
	}
	ignore404 := func(err error) error {
		if err != nil && statusOf(err) != 404 {
			return translate(err)
		}
		return nil
	}
	if err := ignore404(d.api.ContainerRemove(ctx, id.ContainerName(), container.RemoveOptions{Force: true})); err != nil {
		return err
	}
	if err := ignore404(d.api.NetworkRemove(ctx, id.NetworkName())); err != nil {
		return err
	}
	if deleteVolume {
		return ignore404(d.api.VolumeRemove(ctx, id.VolumeName(), false))
	}
	return nil
}

func (d *Docker) VolumeUsage(ctx context.Context) (map[string]int64, error) {
	du, err := d.api.DiskUsage(ctx, types.DiskUsageOptions{Types: []types.DiskUsageObject{types.VolumeObject}})
	if err != nil {
		return nil, translate(err)
	}
	usage := map[string]int64{}
	for _, v := range du.Volumes {
		if v == nil || v.Labels[LabelManaged] == "" || v.Labels[LabelInstance] == "" || v.UsageData == nil || v.UsageData.Size < 0 {
			continue
		}
		usage[strings.ToLower(v.Labels[LabelInstance])] = v.UsageData.Size
	}
	return usage, nil
}

// applyModel writes the managed model block into the (stopped) container's data volume, keeping the rest.
func (d *Docker) applyModel(ctx context.Context, name string, change ModelChange) error {
	var existing *string
	rc, _, err := d.api.CopyFromContainer(ctx, name, DataMount+"/config.yaml")
	switch {
	case statusOf(err) == 404:
	case err != nil:
		return err
	default:
		b, err := CollectCapped(rc, MaxConfigBytes)
		_ = rc.Close()
		if err != nil {
			return err
		}
		if s, ok := ReadFirstFile(b); ok {
			existing = &s
		}
	}
	out, write, err := ApplyModelBlock(existing, change)
	if err != nil || !write {
		return err
	}
	// uid/gid 10000 is the hermes user the image drops to (ADR 0002).
	tar, err := BuildTar("config.yaml", out, 10000, 10000, 0o644, time.Now())
	if err != nil {
		return err
	}
	return d.api.CopyToContainer(ctx, name, DataMount, bytes.NewReader(tar), container.CopyToContainerOptions{})
}

func (d *Docker) containerExists(ctx context.Context, id ID) (bool, error) {
	_, err := d.api.ContainerInspect(ctx, id.ContainerName())
	if statusOf(err) == 404 {
		return false, nil
	}
	return err == nil, err
}

func (d *Docker) volumeExists(ctx context.Context, id ID) (bool, error) {
	_, err := d.api.VolumeInspect(ctx, id.VolumeName())
	if statusOf(err) == 404 {
		return false, nil
	}
	return err == nil, err
}

// ensureVolume creates the tenant volume with its size quota and returns the quota in MB (0: none). An existing
// volume without a quota is refused while quotas are enforced: it must never run unbounded.
func (d *Docker) ensureVolume(ctx context.Context, s Spec, id ID) (int, error) {
	enforce := s.DiskQuota == "enforce"
	v, err := d.api.VolumeInspect(ctx, id.VolumeName())
	if err == nil {
		quota := ReadVolumeQuotaMB(v.Options)
		if enforce && quota == 0 {
			return 0, apperr.VolumeQuotaMissing
		}
		return quota, nil
	}
	if statusOf(err) != 404 {
		return 0, err
	}
	tenant, _ := ParseID(s.TenantID)
	opts := volume.CreateOptions{
		Name:   id.VolumeName(),
		Labels: map[string]string{LabelManaged: "true", LabelInstance: string(id), LabelTenant: string(tenant)},
	}
	if enforce {
		opts.Driver, opts.DriverOpts = "local", SizedVolumeOpts(s.Limits.StorageMB)
	}
	if _, err := d.api.VolumeCreate(ctx, opts); err != nil {
		if enforce && IsQuotaUnsupported(err) {
			return 0, apperr.VolumeQuotaMissing
		}
		return 0, err
	}
	if enforce {
		return s.Limits.StorageMB, nil
	}
	return 0, nil
}

// ensureNetwork creates the tenant network with the bridge name the host egress ruleset matches. With the policy
// enforced, a network that exists without that name is never reused: Docker cannot rename a bridge in place.
func (d *Docker) ensureNetwork(ctx context.Context, s Spec, id ID) error {
	enforce := s.EgressPolicy == "enforce"
	check := func(n network.Inspect) error {
		if enforce && n.Options[BridgeNameOption] != id.BridgeName() {
			return apperr.NetworkPolicyMissing
		}
		return nil
	}
	n, err := d.api.NetworkInspect(ctx, id.NetworkName(), network.InspectOptions{})
	if err == nil {
		return check(n)
	}
	if statusOf(err) != 404 {
		return err
	}
	name, opts, err := BuildNetworkConfig(s.InstanceID, s.TenantID)
	if err != nil {
		return err
	}
	_, err = d.api.NetworkCreate(ctx, name, opts)
	switch {
	case err == nil:
		return nil
	case statusOf(err) == 409:
		// Lost a race with a concurrent Ensure: judge the winner, never retry.
		n, err := d.api.NetworkInspect(ctx, name, network.InspectOptions{})
		if err != nil {
			return err
		}
		return check(n)
	case enforce && statusOf(err) == 403 && strings.Contains(strings.ToLower(err.Error()), "same bridge name"):
		d.log.Warn("tenant bridge name already in use", "instanceId", string(id), "reason", "bridge_name_conflict")
		return apperr.NetworkPolicyMissingMsg("Tenant bridge name is already in use")
	}
	return err
}

func (d *Docker) ensureImage(ctx context.Context, ref string) error {
	_, err := d.api.ImageInspect(ctx, ref)
	if err == nil {
		return nil
	}
	if statusOf(err) != 404 {
		return err
	}
	rc, err := d.api.ImagePull(ctx, ref, image.PullOptions{})
	if err != nil {
		return err
	}
	defer rc.Close()
	// The pull reports its own failure inside the progress stream.
	return jsonmessage.DisplayJSONMessagesStream(rc, io.Discard, 0, false, nil)
}

func containerPortKey() nat.Port { return nat.Port(fmt.Sprintf("%d/tcp", ContainerPort)) }

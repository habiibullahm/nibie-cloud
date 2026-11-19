package runtime

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

// CanaryScript is static: nothing from outside is interpolated, probes arrive as "check host port" triples. A
// missing or unusable nc fails loudly, otherwise every probe would look "blocked". Same text as egress-canary.ts.
const CanaryScript = `command -v nc >/dev/null 2>&1 || { echo error=nc_missing; exit 127; }
( nc -l -p 47321 >/dev/null 2>&1 || nc -l 47321 >/dev/null 2>&1 ) &
sleep 1
nc -z -w 1 127.0.0.1 47321 >/dev/null 2>&1 || { echo error=nc_unusable; exit 126; }
while [ "$#" -ge 3 ]; do
  if nc -z -w 3 "$2" "$3" >/dev/null 2>&1; then echo "$1=connected"; else echo "$1=blocked"; fi
  shift 3
done`

const canaryWait = 30 * time.Second

// EgressPolicyError: a blocked target was reachable, so the host ruleset is missing or does not match. It names
// the check only.
type EgressPolicyError struct{ Check string }

func (e *EgressPolicyError) Error() string {
	return "Egress policy is not in force (check: " + e.Check + ")"
}

// EgressCanaryError: the canary itself could not run or could not prove anything. It never carries Docker text or
// addresses.
type EgressCanaryError struct{ Reason string }

func (e *EgressCanaryError) Error() string { return "Egress canary could not run" }

// ListenFunc opens a listener that accepts and drops connections on an ephemeral port of host.
type ListenFunc func(host string) (port int, closeFn func() error, err error)

// ListenOn is the default ListenFunc.
func ListenOn(host string) (int, func() error, error) {
	ln, err := net.Listen("tcp", net.JoinHostPort(host, "0"))
	if err != nil {
		return 0, nil, err
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, ln.Close, nil
}

// CanaryAPI is the part of Docker the canary uses.
type CanaryAPI interface {
	ImageInspect(ctx context.Context, imageID string, inspectOpts ...client.ImageInspectOption) (image.InspectResponse, error)
	NetworkCreate(ctx context.Context, name string, options network.CreateOptions) (network.CreateResponse, error)
	NetworkInspect(ctx context.Context, networkID string, options network.InspectOptions) (network.Inspect, error)
	NetworkRemove(ctx context.Context, networkID string) error
	ContainerCreate(ctx context.Context, config *container.Config, hostConfig *container.HostConfig, networkingConfig *network.NetworkingConfig, platform *ocispec.Platform, containerName string) (container.CreateResponse, error)
	ContainerStart(ctx context.Context, containerID string, options container.StartOptions) error
	ContainerWait(ctx context.Context, containerID string, condition container.WaitCondition) (<-chan container.WaitResponse, <-chan error)
	ContainerLogs(ctx context.Context, containerID string, options container.LogsOptions) (io.ReadCloser, error)
	ContainerRemove(ctx context.Context, containerID string, options container.RemoveOptions) error
}

type canaryProbe struct {
	check, host string
	port        int
}

type canaryResult struct {
	check     string
	connected bool
}

var canaryChecks = []string{"gateway", "private", "metadata"}

// evaluateCanary fails with *EgressPolicyError for the first probe that connected.
func evaluateCanary(results []canaryResult) error {
	for _, r := range results {
		if r.connected {
			return &EgressPolicyError{Check: r.check}
		}
	}
	return nil
}

var (
	canaryLine  = regexp.MustCompile(`^(gateway|private|metadata)=(connected|blocked)$`)
	canaryError = regexp.MustCompile(`(?m)^error=`)
)

// RunEgressCanary proves the host egress ruleset is in force before the control plane serves traffic. A short-lived
// container on a temporary "hn" network tries to reach listeners opened on the bridge gateway and on the host's
// private address, and the cloud metadata address. A refused connection looks like a blocked one, so the
// listeners are what make a missing rule visible. Everything it creates is removed in all cases. Port of
// egress-canary.ts.
func RunEgressCanary(ctx context.Context, d CanaryAPI, image, privateIP, runtime string, listen ListenFunc, log *slog.Logger) (err error) {
	if listen == nil {
		listen = ListenOn
	}
	name, netOpts, _ := BuildNetworkConfig(randomUUID(), "")
	var closers []func() error
	containerID, networkCreated := "", false
	fail := func(reason string, cause error) error {
		// Only the reason class and a status number: Docker text can embed addresses and host paths.
		log.Error("egress canary could not run", "reason", reason, "status", statusOf(cause))
		return &EgressCanaryError{Reason: reason}
	}
	defer func() {
		// Cleanup never fails the call and never logs Docker text; a failure is logged by reason only, because a
		// leaked network or container would otherwise go unnoticed.
		bg := context.WithoutCancel(ctx)
		for _, c := range closers {
			if c() != nil {
				log.Warn("egress canary cleanup failed", "reason", "listener_close_failed")
			}
		}
		if containerID != "" && d.ContainerRemove(bg, containerID, container.RemoveOptions{Force: true}) != nil {
			log.Warn("egress canary cleanup failed", "reason", "container_remove_failed")
		}
		if networkCreated && d.NetworkRemove(bg, name) != nil {
			log.Warn("egress canary cleanup failed", "reason", "network_remove_failed")
		}
	}()

	if _, err := d.ImageInspect(ctx, image); err != nil {
		if statusOf(err) == 404 {
			return fail("image_missing", err)
		}
		return fail("docker_error", err)
	}
	if _, err := d.NetworkCreate(ctx, name, netOpts); err != nil {
		return fail("network_create_failed", err)
	}
	networkCreated = true
	n, err := d.NetworkInspect(ctx, name, network.InspectOptions{})
	if err != nil {
		return fail("docker_error", err)
	}
	gateway := ""
	if len(n.IPAM.Config) > 0 {
		gateway = n.IPAM.Config[0].Gateway
	}
	if gateway == "" {
		return fail("no_gateway", nil)
	}

	var probes []canaryProbe
	hosts := []struct{ check, host string }{{"gateway", gateway}}
	if privateIP != "" {
		hosts = append(hosts, struct{ check, host string }{"private", privateIP})
	}
	for _, h := range hosts {
		port, closeFn, err := listen(h.host)
		if err != nil {
			return fail("listen_failed", err)
		}
		closers = append(closers, closeFn)
		probes = append(probes, canaryProbe{h.check, h.host, port})
	}
	probes = append(probes, canaryProbe{"metadata", "169.254.169.254", 80})

	cmd := []string{"sh", "-c", CanaryScript, "canary"}
	for _, p := range probes {
		cmd = append(cmd, p.check, p.host, strconv.Itoa(p.port))
	}
	// gVisor's own sandbox threads count against the pids limit: 32 made the script's fork fail under runsc.
	pids := int64(32)
	if runtime == "runsc" {
		pids = 256
	}
	created, err := d.ContainerCreate(ctx,
		&container.Config{Image: image, Cmd: cmd, Tty: true, NetworkDisabled: false},
		&container.HostConfig{
			NetworkMode: container.NetworkMode(name), CapDrop: []string{"ALL"}, SecurityOpt: []string{"no-new-privileges"},
			ReadonlyRootfs: true, Runtime: runtime,
			Resources: container.Resources{Memory: 32 << 20, MemorySwap: 32 << 20, PidsLimit: &pids},
		}, nil, nil, "")
	if err != nil {
		return fail("container_failed", err)
	}
	containerID = created.ID
	if err := d.ContainerStart(ctx, containerID, container.StartOptions{}); err != nil {
		return fail("container_failed", err)
	}
	exitCode, err := waitExit(ctx, d, containerID, canaryWait)
	if err != nil {
		return fail("container_failed", err)
	}
	rc, err := d.ContainerLogs(ctx, containerID, container.LogsOptions{ShowStdout: true, ShowStderr: true})
	if err != nil {
		return fail("container_failed", err)
	}
	raw, err := io.ReadAll(io.LimitReader(rc, 1<<20))
	_ = rc.Close()
	if err != nil {
		return fail("container_failed", err)
	}
	output := string(raw)

	results := map[string]bool{}
	for _, line := range strings.Split(output, "\n") {
		if m := canaryLine.FindStringSubmatch(strings.TrimSpace(line)); m != nil {
			results[m[1]] = m[2] == "connected"
		}
	}
	for _, p := range probes {
		if _, ok := results[p.check]; !ok {
			return fail("probe_failed", nil)
		}
	}
	if exitCode != 0 || canaryError.MatchString(output) {
		return fail("probe_failed", nil)
	}
	var ordered []canaryResult
	for _, c := range canaryChecks {
		if v, ok := results[c]; ok {
			ordered = append(ordered, canaryResult{c, v})
		}
	}
	if err := evaluateCanary(ordered); err != nil {
		return err
	}
	var names []string
	for _, p := range probes {
		names = append(names, p.check)
	}
	log.Info("egress canary passed", "checks", slices.Clip(names))
	return nil
}

// waitExit waits for a container to stop, at most limit, and returns its exit code.
func waitExit(ctx context.Context, d interface {
	ContainerWait(ctx context.Context, containerID string, condition container.WaitCondition) (<-chan container.WaitResponse, <-chan error)
}, id string, limit time.Duration) (int64, error) {
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	res, errc := d.ContainerWait(ctx, id, container.WaitConditionNotRunning)
	select {
	case r := <-res:
		if r.Error != nil {
			return 0, errors.New("wait failed")
		}
		return r.StatusCode, nil
	case err := <-errc:
		return 0, err
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

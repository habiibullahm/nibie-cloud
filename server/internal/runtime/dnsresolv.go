package runtime

import (
	"context"
	"log/slog"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

// DNSResolvSeedScript is static: resolvers arrive as argv, nothing is interpolated. Same text as dns-resolv-conf.ts.
const DNSResolvSeedScript = `: > /dns/resolv.conf
while [ "$#" -ge 1 ]; do
  echo "nameserver $1" >> /dns/resolv.conf
  shift
done`

const dnsSeedWait = 15 * time.Second

// DNSResolvConfError: the shared resolv.conf volume could not be prepared. It never carries Docker text.
type DNSResolvConfError struct{ Reason string }

func (e *DNSResolvConfError) Error() string {
	return "Could not prepare the tenant DNS resolv.conf volume"
}

// SeedAPI is the part of Docker EnsureDNSResolvConf uses.
type SeedAPI interface {
	VolumeInspect(ctx context.Context, volumeID string) (volume.Volume, error)
	VolumeCreate(ctx context.Context, options volume.CreateOptions) (volume.Volume, error)
	ContainerCreate(ctx context.Context, config *container.Config, hostConfig *container.HostConfig, networkingConfig *network.NetworkingConfig, platform *ocispec.Platform, containerName string) (container.CreateResponse, error)
	ContainerStart(ctx context.Context, containerID string, options container.StartOptions) error
	ContainerWait(ctx context.Context, containerID string, condition container.WaitCondition) (<-chan container.WaitResponse, <-chan error)
	ContainerRemove(ctx context.Context, containerID string, options container.RemoveOptions) error
}

// EnsureDNSResolvConf writes resolvers into the single resolv.conf of DNSResolvVolume (created when missing). A
// runsc tenant bind-mounts that file over its own /etc/resolv.conf, because Docker's embedded resolver is not
// reachable from inside a gVisor sandbox. A no-op without resolvers. Port of dns-resolv-conf.ts.
func EnsureDNSResolvConf(ctx context.Context, d SeedAPI, image string, resolvers []string, runtime string, log *slog.Logger) error {
	if len(resolvers) == 0 {
		return nil
	}
	fail := func(reason string, cause error) error {
		log.Error("dns resolv.conf volume could not be prepared", "reason", reason, "status", statusOf(cause))
		return &DNSResolvConfError{Reason: reason}
	}
	if _, err := d.VolumeInspect(ctx, DNSResolvVolume); err != nil {
		if statusOf(err) != 404 {
			return fail("docker_error", err)
		}
		if _, err := d.VolumeCreate(ctx, volume.CreateOptions{Name: DNSResolvVolume, Labels: map[string]string{LabelManaged: "true"}}); err != nil {
			return fail("volume_create_failed", err)
		}
	}
	pids := int64(32) // gVisor's sandbox threads count against the limit (same fix as the egress canary)
	if runtime == "runsc" {
		pids = 256
	}
	created, err := d.ContainerCreate(ctx,
		&container.Config{Image: image, Cmd: append([]string{"sh", "-c", DNSResolvSeedScript, "seed"}, resolvers...)},
		&container.HostConfig{
			NetworkMode: "none", CapDrop: []string{"ALL"}, SecurityOpt: []string{"no-new-privileges"}, ReadonlyRootfs: true,
			Resources: container.Resources{Memory: 32 << 20, MemorySwap: 32 << 20, PidsLimit: &pids},
			Mounts:    []mount.Mount{{Target: "/dns", Source: DNSResolvVolume, Type: mount.TypeVolume}},
			Runtime:   runtime,
		}, nil, nil, "")
	if err != nil {
		return fail("container_failed", err)
	}
	defer func() {
		// The volume stays (it is shared); the seed container always goes, and a failure is logged by reason only.
		if d.ContainerRemove(context.WithoutCancel(ctx), created.ID, container.RemoveOptions{Force: true}) != nil {
			log.Warn("dns resolv.conf seed cleanup failed", "reason", "container_remove_failed")
		}
	}()
	if err := d.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		return fail("container_failed", err)
	}
	code, err := waitExit(ctx, d, created.ID, dnsSeedWait)
	if err != nil {
		return fail("container_failed", err)
	}
	if code != 0 {
		return fail("seed_failed", nil)
	}
	log.Info("tenant dns resolv.conf ready", "resolvers", len(resolvers))
	return nil
}

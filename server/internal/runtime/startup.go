package runtime

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"

	"github.com/docker/docker/api/types/system"
	"github.com/docker/docker/api/types/volume"
)

// randomUUID is a random (version 4) UUID, for throwaway Docker resources.
func randomUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6], b[8] = b[6]&0x0f|0x40, b[8]&0x3f|0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// InfoAPI is the Docker call AssertRuntimeAvailable needs.
type InfoAPI interface {
	Info(ctx context.Context) (system.Info, error)
}

// AssertRuntimeAvailable fails fast at startup when the configured OCI runtime is not installed on the Docker
// host. runc is the daemon default and always present.
func AssertRuntimeAvailable(ctx context.Context, d InfoAPI, runtime string) error {
	if runtime == "" || runtime == "runc" {
		return nil
	}
	info, err := d.Info(ctx)
	if err != nil {
		return translate(err)
	}
	if _, ok := info.Runtimes[runtime]; !ok {
		return fmt.Errorf("Docker runtime %q is not available on this host", runtime)
	}
	return nil
}

// VolumeAPI is the part of Docker AssertDiskQuotaSupported needs.
type VolumeAPI interface {
	VolumeCreate(ctx context.Context, options volume.CreateOptions) (volume.Volume, error)
	VolumeInspect(ctx context.Context, volumeID string) (volume.Volume, error)
	VolumeRemove(ctx context.Context, volumeID string, force bool) error
}

var errNoDiskQuota = errors.New("HERMES_DISK_QUOTA=enforce but Docker cannot create size-limited volumes on this host " +
	"(needs XFS with project quotas; see docs/setup.md)")

// AssertDiskQuotaSupported fails fast at startup when Docker cannot create size-limited volumes: it creates and
// removes a small probe volume. Whether the kernel then enforces the size is checked by the live harness. The
// error never carries Docker's text (it can hold host paths).
func AssertDiskQuotaSupported(ctx context.Context, d VolumeAPI, mode string) error {
	if mode == "off" {
		return nil
	}
	name := "hermes-quota-probe-" + randomUUID()
	if _, err := d.VolumeCreate(ctx, volume.CreateOptions{Name: name, Driver: "local", DriverOpts: SizedVolumeOpts(64)}); err != nil {
		return errNoDiskQuota
	}
	defer func() { _ = d.VolumeRemove(context.WithoutCancel(ctx), name, false) }()
	v, err := d.VolumeInspect(ctx, name)
	if err != nil || ReadVolumeQuotaMB(v.Options) == 0 {
		return errNoDiskQuota
	}
	return nil
}

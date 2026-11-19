package runtime

import (
	"context"
	"time"
)

// ResourceLimits are a plan's limits for one container.
type ResourceLimits struct {
	CPUMillis int
	MemoryMB  int
	Pids      int
	// StorageMB is the persistent volume quota, enforced by the kernel when the volume is created.
	StorageMB int
}

// ModelConfig is the platform-managed model block of /opt/data/config.yaml (ADR 0003). The provider key is never
// in it; it travels in the environment.
type ModelConfig struct {
	Default string
	BaseURL string
	KeyEnv  string
}

// ModelChange says what to do with the model block when a container is created. A nil *ModelChange leaves the
// file alone; Remove deletes a block the platform wrote earlier; otherwise Config is written.
type ModelChange struct {
	Remove bool
	Config ModelConfig
}

// Spec describes one tenant container. DiskQuota and EgressPolicy are "enforce" or "off"; Runtime is "", "runc"
// or "runsc"; DNS holds explicit IPv4 resolvers (empty: Docker's embedded resolver).
type Spec struct {
	InstanceID   string
	TenantID     string
	Image        string
	Limits       ResourceLimits
	DiskQuota    string
	EgressPolicy string
	Env          map[string]string
	Runtime      string
	DNS          []string
	APIServerKey string
	Model        *ModelChange
}

// State is a container state as Docker reports it, or StateAbsent when there is no container.
type State string

const (
	StateAbsent     State = "absent"
	StateCreated    State = "created"
	StateRunning    State = "running"
	StateExited     State = "exited"
	StateRestarting State = "restarting"
	StateDead       State = "dead"
)

// Inspection is what the platform needs to know about a container. ExitCode is nil while it runs or was only
// created; HostPort is 0 unless it runs.
type Inspection struct {
	State         State
	ExitCode      *int
	OOMKilled     bool
	StartedAt     *time.Time
	HostPort      int
	VolumePresent bool
}

// AuthRejectedDetail is Health.Detail when the gateway answered 401 to the key we sent: a restart cannot fix it.
const AuthRejectedDetail = "auth rejected"

// Health is the result of one health probe.
type Health struct {
	OK        bool
	LatencyMs int64
	Detail    string
}

// EnsureResult reports what Ensure left in place. VolumeQuotaMB is 0 when the volume has no quota.
type EnsureResult struct {
	HostPort      int
	VolumeQuotaMB int
}

// Manager is the only seam through which the rest of the platform touches containers (PRD 6.3).
type Manager interface {
	// Ensure makes sure network, volume and an (unstarted) container exist. Idempotent.
	Ensure(ctx context.Context, s Spec) (EnsureResult, error)
	// Recreate removes the container (network and volume stay) and creates it again from s. Does not start it.
	Recreate(ctx context.Context, s Spec) (EnsureResult, error)
	// AssertVolumeQuota fails with apperr.VolumeQuotaMissing when mode is "enforce" and the volume is absent or
	// has no quota. Used by the paths that start an existing container without Ensure.
	AssertVolumeQuota(ctx context.Context, instanceID, mode string) error
	// AssertNetworkPolicy fails with apperr.NetworkPolicyMissing when mode is "enforce" and the network is absent
	// or lacks the "hn" bridge name.
	AssertNetworkPolicy(ctx context.Context, instanceID, mode string) error
	// Logs returns the last tail lines (1..500) of stdout and stderr, oldest first. Raw: callers must redact.
	Logs(ctx context.Context, instanceID string, tail int) ([]string, error)
	Start(ctx context.Context, instanceID string) error
	// Stop is a no-op when the container is already stopped or absent.
	Stop(ctx context.Context, instanceID string, timeoutSec int) error
	Restart(ctx context.Context, instanceID string) error
	// Inspect reports StateAbsent when no container exists.
	Inspect(ctx context.Context, instanceID string) (Inspection, error)
	// CheckHealth never fails: problems are reported in Health.
	CheckHealth(ctx context.Context, instanceID, apiServerKey string) Health
	// VolumeUsage returns used bytes per tenant volume, keyed by instance id, from one Docker call.
	VolumeUsage(ctx context.Context) (map[string]int64, error)
	// Remove is a no-op when absent. The volume is kept unless deleteVolume.
	Remove(ctx context.Context, instanceID string, deleteVolume bool) error
}

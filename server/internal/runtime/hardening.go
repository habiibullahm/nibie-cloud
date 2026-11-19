package runtime

import (
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strconv"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/go-connections/nat"

	"github.com/habiibullahm/nibie-cloud/server/internal/shared/apperr"
)

// The official Hermes image contract and the hardening baseline (port of src/modules/runtime/hardening.ts; the
// evidence behind each value is in docs/architecture.md and ADR 0002).
const (
	ContainerPort    = 8642
	DataMount        = "/opt/data"
	LabelManaged     = "hermes.cloud/managed"
	LabelInstance    = "hermes.cloud/instance-id"
	LabelTenant      = "hermes.cloud/tenant-id"
	BridgeNameOption = "com.docker.network.bridge.name"
	DNSResolvVolume  = "hermes-dns-resolv-conf"
	DNSResolvSubpath = "resolv.conf"
)

// S6RequiredCaps are the capabilities the image's s6-overlay init needs (measured: removing any of SETUID,
// SETGID, CHOWN, DAC_OVERRIDE, FOWNER breaks boot; with none re-added the container exit-loops).
var S6RequiredCaps = []string{"SETUID", "SETGID", "CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "AUDIT_WRITE", "SETFCAP"}

// S6Tmpfs are the writable mounts s6-overlay needs on a read-only root filesystem.
var S6Tmpfs = map[string]string{
	"/run":     "rw,exec,nosuid,size=64m",
	"/tmp":     "rw,noexec,nosuid,size=64m",
	"/var/run": "rw,exec,nosuid,size=16m",
}

// logConfig bounds container log files on the host: worst case about 30 MB per tenant.
func logConfig() container.LogConfig {
	return container.LogConfig{Type: "json-file", Config: map[string]string{"max-size": "10m", "max-file": "3"}}
}

var dockerEnvKey = regexp.MustCompile(`(?i)^DOCKER_`)

// CreateRequest is a container create call: the name and the two request bodies.
type CreateRequest struct {
	Name   string
	Config *container.Config
	Host   *container.HostConfig
}

// BuildNetworkConfig is the tenant network: its own bridge with the policy-matched name, ICC off, IPv6 off.
// tenantID may be "" (the egress canary's network has no tenant).
func BuildNetworkConfig(instanceID, tenantID string) (string, network.CreateOptions, error) {
	id, err := ParseID(instanceID)
	if err != nil {
		return "", network.CreateOptions{}, err
	}
	labels := map[string]string{LabelManaged: "true", LabelInstance: string(id)}
	if tenantID != "" {
		tenant, err := ParseID(tenantID)
		if err != nil {
			return "", network.CreateOptions{}, err
		}
		labels[LabelTenant] = string(tenant)
	}
	ipv6 := false
	return id.NetworkName(), network.CreateOptions{
		Driver:     "bridge",
		EnableIPv6: &ipv6,
		Options: map[string]string{
			BridgeNameOption:                       id.BridgeName(),
			"com.docker.network.bridge.enable_icc": "false",
		},
		Labels: labels,
	}, nil
}

// BuildContainerConfig validates s and returns the tenant container's create request. It never touches Docker.
func BuildContainerConfig(s Spec) (CreateRequest, error) {
	id, err := ParseID(s.InstanceID)
	if err != nil {
		return CreateRequest{}, err
	}
	tenant, err := ParseID(s.TenantID)
	if err != nil {
		return CreateRequest{}, err
	}
	l := s.Limits
	switch {
	case l.CPUMillis < 50:
		return CreateRequest{}, apperr.Validation("cpuMillis must be an integer >= 50")
	case l.MemoryMB < 32:
		return CreateRequest{}, apperr.Validation("memoryMb must be an integer >= 32")
	case l.Pids < 8:
		return CreateRequest{}, apperr.Validation("pids must be an integer >= 8")
	case l.StorageMB < 64:
		return CreateRequest{}, apperr.Validation("storageMb must be an integer >= 64")
	}
	for k := range s.Env {
		if dockerEnvKey.MatchString(k) {
			return CreateRequest{}, apperr.Validation("Environment key not allowed")
		}
	}

	env := maps.Clone(s.Env)
	if env == nil {
		env = map[string]string{}
	}
	if env["API_SERVER_HOST"] == "" {
		env["API_SERVER_HOST"] = "0.0.0.0"
	}
	if env["API_SERVER_PORT"] == "" {
		env["API_SERVER_PORT"] = strconv.Itoa(ContainerPort)
	}
	if s.APIServerKey != "" && env["API_SERVER_KEY"] == "" {
		env["API_SERVER_KEY"] = s.APIServerKey
	}
	envList := make([]string, 0, len(env))
	for _, k := range slices.Sorted(maps.Keys(env)) {
		envList = append(envList, k+"="+env[k])
	}

	port := nat.Port(fmt.Sprintf("%d/tcp", ContainerPort))
	pids := int64(l.Pids)
	initOff := false
	host := &container.HostConfig{
		Privileged:     false,
		CapDrop:        []string{"ALL"},
		CapAdd:         slices.Clone(S6RequiredCaps),
		SecurityOpt:    []string{"no-new-privileges:true"},
		ReadonlyRootfs: true,
		Tmpfs:          maps.Clone(S6Tmpfs),
		Resources: container.Resources{
			Memory:     int64(l.MemoryMB) * 1048576,
			MemorySwap: int64(l.MemoryMB) * 1048576,
			NanoCPUs:   int64(l.CPUMillis) * 1_000_000,
			PidsLimit:  &pids,
		},
		// Never true: the image is PID 1 with its own s6-overlay dispatcher.
		Init:          &initOff,
		RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyDisabled},
		LogConfig:     logConfig(),
		Binds:         []string{id.VolumeName() + ":" + DataMount},
		NetworkMode:   container.NetworkMode(id.NetworkName()),
		PortBindings:  nat.PortMap{port: {{HostIP: "127.0.0.1", HostPort: "0"}}},
		Runtime:       s.Runtime,
	}
	if len(s.DNS) > 0 {
		host.DNS = slices.Clone(s.DNS)
	}
	// Under runsc the embedded resolver is unreachable from inside the sandbox, so a real resolv.conf (seeded by
	// EnsureDNSResolvConf) is bind-mounted over the container's own.
	if s.Runtime == "runsc" && len(s.DNS) > 0 {
		host.Mounts = []mount.Mount{{
			Target: "/etc/resolv.conf", Source: DNSResolvVolume, Type: mount.TypeVolume, ReadOnly: true,
			VolumeOptions: &mount.VolumeOptions{
				Subpath: DNSResolvSubpath, NoCopy: false, Labels: map[string]string{},
				DriverConfig: &mount.Driver{Name: "", Options: map[string]string{}},
			},
		}}
	}
	return CreateRequest{
		Name: id.ContainerName(),
		Config: &container.Config{
			Image:        s.Image,
			Cmd:          []string{"gateway", "run"},
			Env:          envList,
			ExposedPorts: nat.PortSet{port: struct{}{}},
			Labels:       map[string]string{LabelManaged: "true", LabelInstance: string(id), LabelTenant: string(tenant)},
		},
		Host: host,
	}, nil
}

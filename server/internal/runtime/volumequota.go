package runtime

import (
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"

	cerrdefs "github.com/containerd/errdefs"
)

// Docker's local volume driver enforces a size limit through XFS project quotas when the volume is created with
// the "size" driver option. Without quota support Docker refuses the create (HTTP 400, "... no quota support").

// SizedVolumeOpts are the driver options for a volume capped at mb megabytes.
func SizedVolumeOpts(mb int) map[string]string {
	return map[string]string{"size": strconv.Itoa(mb) + "m"}
}

var quotaSize = regexp.MustCompile(`(?i)^(\d+)([kmgt]?)b?$`)

var unitBytes = map[string]float64{"": 1, "k": 1 << 10, "m": 1 << 20, "g": 1 << 30, "t": 1 << 40}

// ReadVolumeQuotaMB is the quota of an inspected volume in whole MB, or 0 when it has none or an unreadable one.
func ReadVolumeQuotaMB(opts map[string]string) int {
	raw := opts["size"]
	if raw == "" {
		return 0
	}
	m := quotaSize.FindStringSubmatch(strings.TrimSpace(raw))
	if m == nil {
		return 0
	}
	n, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0
	}
	mb := math.Floor(n * unitBytes[strings.ToLower(m[2])] / (1 << 20))
	if mb <= 0 || mb > math.MaxInt32 {
		return 0
	}
	return int(mb)
}

// IsQuotaUnsupported reports whether Docker refused a sized volume because the filesystem has no quota support.
func IsQuotaUnsupported(err error) bool {
	return statusOf(err) == 400 && strings.Contains(strings.ToLower(err.Error()), "no quota support")
}

// statusOf is the HTTP status behind a Docker SDK error (0 when there is none).
func statusOf(err error) int {
	if err == nil {
		return 0
	}
	var sc interface{ StatusCode() int }
	if errors.As(err, &sc) {
		return sc.StatusCode()
	}
	switch {
	case cerrdefs.IsNotFound(err):
		return 404
	case cerrdefs.IsConflict(err):
		return 409
	case cerrdefs.IsNotModified(err):
		return 304
	case cerrdefs.IsInvalidArgument(err):
		return 400
	case cerrdefs.IsPermissionDenied(err):
		return 403
	case cerrdefs.IsUnauthorized(err):
		return 401
	case cerrdefs.IsUnavailable(err):
		return 503
	case cerrdefs.IsInternal(err):
		return 500
	}
	return 0
}

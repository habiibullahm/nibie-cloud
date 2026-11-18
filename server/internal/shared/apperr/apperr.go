// Package apperr holds the typed errors the backend returns to callers, with the HTTP status, the error code
// and the default message of src/shared/errors.ts. Later milestones add the rest of that file here.
package apperr

// Error is an error a caller may see: a status, a stable code and a message without internal detail.
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

// Is matches by code, so a sentinel matches the same error with another message: errors.Is(err, VolumeQuotaMissing).
func (e *Error) Is(target error) bool {
	t, ok := target.(*Error)
	return ok && t.Code == e.Code
}

// Validation is a bad input (400).
func Validation(msg string) *Error {
	return &Error{Status: 400, Code: "validation_error", Message: msg}
}

var (
	// RuntimeUnavailable: the Docker daemon cannot be reached (503).
	RuntimeUnavailable = &Error{Status: 503, Code: "runtime_unavailable", Message: "Runtime is temporarily unavailable"}
	// VolumeQuotaMissing: a tenant volume has no disk quota while quotas are enforced (409).
	VolumeQuotaMissing = &Error{Status: 409, Code: "volume_quota_missing", Message: "Tenant volume has no disk quota"}
	// NetworkPolicyMissing: the tenant network lacks the bridge name the host egress ruleset matches (409).
	NetworkPolicyMissing = &Error{Status: 409, Code: "network_policy_missing", Message: "Tenant network does not match the egress policy"}
	// ConfigUnreadable: the tenant's config.yaml cannot be read, so it is left untouched (409).
	ConfigUnreadable = &Error{Status: 409, Code: "config_unreadable", Message: "The instance configuration file could not be read"}
)

// NetworkPolicyMissingMsg is NetworkPolicyMissing with a more specific message.
func NetworkPolicyMissingMsg(msg string) *Error {
	return &Error{Status: 409, Code: "network_policy_missing", Message: msg}
}

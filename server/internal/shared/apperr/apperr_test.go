package apperr

import (
	"errors"
	"fmt"
	"testing"
)

// TestErrorsMatchNode: status, code and default message are the ones in src/shared/errors.ts.
func TestErrorsMatchNode(t *testing.T) {
	cases := []struct {
		err           *Error
		status        int
		code, message string
	}{
		{Validation("Invalid instance id"), 400, "validation_error", "Invalid instance id"},
		{RuntimeUnavailable, 503, "runtime_unavailable", "Runtime is temporarily unavailable"},
		{VolumeQuotaMissing, 409, "volume_quota_missing", "Tenant volume has no disk quota"},
		{NetworkPolicyMissing, 409, "network_policy_missing", "Tenant network does not match the egress policy"},
		{NetworkPolicyMissingMsg("Tenant bridge name is already in use"), 409, "network_policy_missing", "Tenant bridge name is already in use"},
		{ConfigUnreadable, 409, "config_unreadable", "The instance configuration file could not be read"},
	}
	for _, c := range cases {
		if c.err.Status != c.status || c.err.Code != c.code || c.err.Message != c.message || c.err.Error() != c.message {
			t.Errorf("%+v, want %d %s %q", *c.err, c.status, c.code, c.message)
		}
	}
}

func TestIsMatchesByCode(t *testing.T) {
	if !errors.Is(fmt.Errorf("wrap: %w", VolumeQuotaMissing), VolumeQuotaMissing) {
		t.Fatal("a wrapped sentinel must match")
	}
	if !errors.Is(NetworkPolicyMissingMsg("other text"), NetworkPolicyMissing) {
		t.Fatal("the same code with another message must match")
	}
	if errors.Is(Validation("x"), RuntimeUnavailable) {
		t.Fatal("different codes must not match")
	}
	var e *Error
	if !errors.As(fmt.Errorf("wrap: %w", ConfigUnreadable), &e) || e.Status != 409 {
		t.Fatal("errors.As must find the *Error")
	}
}

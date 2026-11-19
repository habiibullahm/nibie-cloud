// Package runtime is the only code that talks to Docker (port of src/modules/runtime). The rest of the
// backend uses the Manager interface; every operation is keyed by instance UUID, and Docker resource names
// derive only from that UUID, never from customer text.
package runtime

import (
	"regexp"
	"strings"

	"github.com/habiibullahm/nibie-cloud/server/internal/shared/apperr"
)

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// ID is a validated, lowercased instance (or tenant) UUID.
type ID string

// ParseID accepts a UUID in any case and lowercases it.
func ParseID(s string) (ID, error) {
	if !uuidPattern.MatchString(s) {
		return "", apperr.Validation("Invalid instance id")
	}
	return ID(strings.ToLower(s)), nil
}

func (id ID) ContainerName() string { return "hermes-" + string(id) }
func (id ID) VolumeName() string    { return "hermes-data-" + string(id) }
func (id ID) NetworkName() string   { return "hermes-net-" + string(id) }

// BridgeName is the Linux interface name of the tenant bridge: "hn" plus the first 12 hex characters of the
// UUID (14 characters, under the 15-character limit). The host ruleset in ops/egress matches the "hn" prefix.
func (id ID) BridgeName() string { return "hn" + strings.ReplaceAll(string(id), "-", "")[:12] }

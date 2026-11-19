package runtime

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
)

// APIKeyLabel is the versioned domain label: a future derivation scheme can coexist under a new label.
const APIKeyLabel = "hermes-cloud/api-server-key/v1:"

// DeriveAPIKey is the per-instance API_SERVER_KEY, derived rather than stored: the same master key and instance
// id always give the same key, so a container can be recreated with the key it had.
func DeriveAPIKey(masterKey, instanceID string) (string, error) {
	id, err := ParseID(instanceID)
	if err != nil {
		return "", err
	}
	m := hmac.New(sha256.New, []byte(masterKey))
	m.Write([]byte(APIKeyLabel + string(id)))
	return hex.EncodeToString(m.Sum(nil)), nil
}

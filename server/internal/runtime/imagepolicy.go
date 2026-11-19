package runtime

import (
	"regexp"
	"strings"
	"unicode"

	"github.com/habiibullahm/nibie-cloud/server/internal/shared/apperr"
)

var digestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// AssertPinnedImage refuses an image that is not pinned (PRD 7.1): never "latest", never untagged, and with
// production a content digest is required. Port of src/modules/runtime/image-policy.ts, same messages.
func AssertPinnedImage(image string, production bool) error {
	fail := func(why string) error { return apperr.Validation("Hermes image is not pinned: " + why) }
	if image == "" || strings.IndexFunc(image, unicode.IsSpace) >= 0 {
		return fail("empty or contains whitespace")
	}
	ref, digest := image, ""
	if at := strings.Index(image, "@"); at >= 0 {
		ref, digest = image[:at], image[at+1:]
		if !digestPattern.MatchString(digest) {
			return fail("malformed digest")
		}
	}
	lastSlash := strings.LastIndex(ref, "/")
	hasTag, tag := false, ""
	if colon := strings.Index(ref[lastSlash+1:], ":"); colon >= 0 {
		hasTag, tag = true, ref[lastSlash+1+colon+1:]
	}
	switch {
	case hasTag && tag == "":
		return fail("empty tag")
	case strings.EqualFold(tag, "latest"):
		return fail(`tag "latest" is not allowed`)
	case tag == "" && digest == "":
		return fail("an explicit tag or digest is required")
	case production && digest == "":
		return fail("production requires an @sha256 digest")
	}
	return nil
}

package logger

import "testing"

// Port of test/unit/logger.test.ts 'maskIp', plus the zone and hex-mapped forms.
func TestMaskIP(t *testing.T) {
	for in, want := range map[string]string{
		"203.0.113.77":           "203.0.113.0",
		"2001:db8:aa:bb:1:2:3:4": "2001:db8:aa::",
		"2001:0db8:00aa::9":      "2001:db8:aa::",
		"2001:db8:1:2::5":        "2001:db8:1::",
		"::ffff:203.0.113.77":    "203.0.113.0",
		"::FFFF:198.51.100.9":    "198.51.100.0",
		"::ffff:cb00:714d":       "0:0:0::", // Node only unwraps the dotted form
		"fe80::1%eth0":           "fe80:0:0::",
		"::1":                    "0:0:0::",
		"":                       "",
		"alice@example.test":     "",
		"203.0.113.077":          "",
		"not-an-ip":              "",
	} {
		if got := MaskIP(in); got != want {
			t.Errorf("MaskIP(%q) = %q, want %q", in, got, want)
		}
	}
}

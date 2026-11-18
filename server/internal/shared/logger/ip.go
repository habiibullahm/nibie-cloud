package logger

import (
	"net/netip"
	"regexp"
	"strconv"
	"strings"
)

var mappedV4 = regexp.MustCompile(`(?i)^::ffff:([0-9]{1,3}(?:\.[0-9]{1,3}){3})$`)

// MaskIP cuts an address down to its network for logs: the /24 of IPv4 (203.0.113.0), the /48 of IPv6
// (2001:db8:1::). An IPv4-mapped address written in dotted form counts as the IPv4 address it wraps.
// Anything that is not an IP address gives "", so a bad value never reaches a log line.
// Port of src/shared/ip.ts maskIp.
func MaskIP(ip string) string {
	a, err := netip.ParseAddr(ip)
	if err != nil {
		return ""
	}
	if m := mappedV4.FindStringSubmatch(ip); m != nil {
		return maskV4(m[1])
	}
	if a.Is4() {
		return maskV4(ip)
	}
	b := a.As16()
	groups := make([]string, 3)
	for i := range groups {
		groups[i] = strconv.FormatUint(uint64(b[2*i])<<8|uint64(b[2*i+1]), 16)
	}
	return strings.Join(groups, ":") + "::"
}

func maskV4(ip string) string {
	parts := strings.Split(ip, ".")
	return strings.Join(parts[:3], ".") + ".0"
}

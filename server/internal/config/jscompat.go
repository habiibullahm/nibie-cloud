package config

// Helpers that reproduce how the Node backend (zod on JavaScript strings) read the environment, so the
// Go config accepts and refuses exactly the same values. Each one is pinned by the golden cases in
// testdata/golden/config.golden.json.

import (
	"math"
	"math/big"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

// jsIsSpace is JavaScript's WhiteSpace plus LineTerminator: what String.prototype.trim removes and \s matches.
func jsIsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	}
	return r >= '\u2000' && r <= '\u200a'
}

func jsTrim(s string) string { return strings.TrimFunc(s, jsIsSpace) }

// jsLen is a string's length in UTF-16 code units, which is what zod's min/max count.
func jsLen(s string) int { return len(utf16.Encode([]rune(s))) }

// jsWS is jsIsSpace as a regexp class body, for patterns that used \s in JavaScript.
const jsWS = `\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

var (
	jsDecimal  = regexp.MustCompile(`^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)
	jsPrefixed = regexp.MustCompile(`^0([xXoObB])([0-9a-fA-F]+)$`)
	jsInfinity = regexp.MustCompile(`^[+-]?Infinity$`)
)

// jsNumber is JavaScript's Number(string). It returns NaN for anything Number() would not parse.
func jsNumber(s string) float64 {
	t := jsTrim(s)
	if t == "" {
		return 0
	}
	if jsInfinity.MatchString(t) {
		if t[0] == '-' {
			return math.Inf(-1)
		}
		return math.Inf(1)
	}
	if m := jsPrefixed.FindStringSubmatch(t); m != nil {
		base := map[byte]int{'x': 16, 'X': 16, 'o': 8, 'O': 8, 'b': 2, 'B': 2}[m[1][0]]
		n, ok := new(big.Int).SetString(m[2], base)
		if !ok {
			return math.NaN()
		}
		f, _ := new(big.Float).SetInt(n).Float64()
		return f
	}
	if !jsDecimal.MatchString(t) {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil && !strings.Contains(err.Error(), "value out of range") {
		return math.NaN()
	}
	return f // ParseFloat returns \u00b1Inf for out-of-range values, as Number() does
}

var zodIPv4 = regexp.MustCompile(`^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$`)

// isIPv4 is zod's z.ipv4(): dotted quad, no leading zeros, no surrounding space.
func isIPv4(s string) bool { return zodIPv4.MatchString(s) }

var kekChars = regexp.MustCompile(`^[A-Za-z0-9+/]+={0,2}$`)

// kek32 accepts what `/^[A-Za-z0-9+/]+={0,2}$/` plus `Buffer.from(v, 'base64').length === 32` accepted:
// exactly 43 base64 characters of data, with or without padding.
func kek32(s string) ([]byte, bool) {
	if !kekChars.MatchString(s) {
		return nil, false
	}
	data := strings.TrimRight(s, "=")
	if len(data)*6/8 != 32 {
		return nil, false
	}
	return decodeLenient(data)
}

// decodeLenient decodes unpadded standard base64 the way Node's Buffer does: trailing bits are ignored.
func decodeLenient(data string) ([]byte, bool) {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	out := make([]byte, 0, len(data)*6/8)
	var acc uint32
	bits := 0
	for i := 0; i < len(data); i++ {
		v := strings.IndexByte(alphabet, data[i])
		if v < 0 {
			return nil, false
		}
		acc = acc<<6 | uint32(v)
		bits += 6
		if bits >= 8 {
			bits -= 8
			out = append(out, byte(acc>>bits))
		}
	}
	return out, true
}

// isHTTPSURL is `new URL(v).protocol === 'https:'`.
func isHTTPSURL(v string) bool {
	u, err := url.Parse(v)
	return err == nil && u.Scheme == "https" && u.Host != "" && u.Opaque == ""
}

// isRouterOrigin is the NIBIEROUTER_API_URL check: https, path "/" and no query string (a fragment is allowed).
func isRouterOrigin(v string) bool {
	u, err := url.Parse(v)
	return err == nil && isHTTPSURL(v) && (u.Path == "" || u.Path == "/") && u.RawQuery == ""
}

var (
	originSchemes = map[string]string{"http": "80", "https": "443", "ws": "80", "wss": "443", "ftp": "21"}
	hostChars     = regexp.MustCompile(`^[a-z0-9._-]+$`)
	numericLabel  = regexp.MustCompile(`^(?:[0-9]+|0[xX][0-9a-fA-F]*)$`)
	decimalPort   = regexp.MustCompile(`^(?:0|[1-9][0-9]{0,4})$`)
)

// exactOrigin is `new URL(raw).origin === raw`: raw must already be the canonical origin, so a path, query,
// fragment, credentials, a default port, an uppercase or non-canonical host all make it false.
func exactOrigin(raw string, httpsOnly bool) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Opaque != "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || strings.Contains(raw, "#") {
		return false
	}
	defPort, ok := originSchemes[u.Scheme]
	if !ok || (httpsOnly && u.Scheme != "https") || raw != u.Scheme+"://"+u.Host || strings.HasSuffix(u.Host, ":") {
		return false
	}
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || !decimalPort.MatchString(p) || n > 65535 || p == defPort {
			return false
		}
	}
	host := u.Hostname()
	if strings.HasPrefix(u.Host, "[") {
		a, err := netip.ParseAddr(host)
		return err == nil && a.Is6() && a.Zone() == "" && !strings.Contains(host, ".") && a.String() == host
	}
	if !hostChars.MatchString(host) {
		return false
	}
	labels := strings.Split(strings.TrimSuffix(host, "."), ".")
	if numericLabel.MatchString(labels[len(labels)-1]) {
		return isIPv4(host) // the WHATWG parser treats it as IPv4 and prints it canonically
	}
	return true
}

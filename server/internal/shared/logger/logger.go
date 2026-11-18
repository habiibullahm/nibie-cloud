// Package logger builds the backend's JSON logger. Values at the paths the Node logger redacted
// (src/shared/logger.ts REDACT_PATHS) are replaced by "[REDACTED]" before they reach any sink.
package logger

import (
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
)

const redacted = "[REDACTED]"

// New returns a JSON logger: "time" (UTC, RFC 3339 with milliseconds), "level", "msg", then the attributes.
func New(w io.Writer, level slog.Level) *slog.Logger {
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{Level: level, ReplaceAttr: replaceAttr}))
}

// ParseLevel reads LOG_LEVEL (pino's names). Anything else is info.
func ParseLevel(s string) slog.Level {
	switch strings.ToLower(s) {
	case "trace", "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error", "fatal":
		return slog.LevelError
	}
	return slog.LevelInfo
}

// RequestAttr is how a request appears in the log: the method, the path without its query string (an admin
// search puts a customer's email there), the host and the client's network (MaskIP), never the port.
func RequestAttr(r *http.Request) slog.Attr {
	uri := r.RequestURI
	if uri == "" {
		uri = r.URL.RequestURI()
	}
	path, _, _ := strings.Cut(uri, "?")
	attrs := []any{"method", r.Method, "url", path, "host", r.Host}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if masked := MaskIP(host); masked != "" {
		attrs = append(attrs, "remoteAddress", masked)
	}
	return slog.Group("req", attrs...)
}

// redactPath reports whether a value at this key path must not be logged. The rules are pino's:
// adminToken, token, *.token, *.apiKey, *.password, *.secret, env.*, *.env.*, req.headers.authorization,
// headers.authorization. Children of a redacted object are redacted too.
func redactPath(p []string) bool {
	n := len(p)
	last := p[n-1]
	switch {
	case n == 1 && (last == "adminToken" || last == "token"):
		return true
	case n == 2 && (last == "token" || last == "apiKey" || last == "password" || last == "secret"):
		return true
	case n >= 2 && p[0] == "env", n >= 3 && p[1] == "env":
		return true
	case n == 3 && p[0] == "req" && p[1] == "headers" && last == "authorization":
		return true
	case n == 2 && p[0] == "headers" && last == "authorization":
		return true
	}
	return false
}

func replaceAttr(groups []string, a slog.Attr) slog.Attr {
	if len(groups) == 0 && a.Key == slog.TimeKey && a.Value.Kind() == slog.KindTime {
		return slog.String(slog.TimeKey, a.Value.Time().UTC().Format("2006-01-02T15:04:05.000Z07:00"))
	}
	path := append(append(make([]string, 0, len(groups)+1), groups...), a.Key)
	if redactPath(path) {
		return slog.String(a.Key, redacted)
	}
	if a.Value.Kind() == slog.KindAny {
		if m, ok := redactMap(path, a.Value.Any()); ok {
			return slog.Any(a.Key, m)
		}
	}
	return a
}

// redactMap applies the same rules inside a plain map logged as one value (not as an slog group).
func redactMap(path []string, v any) (map[string]any, bool) {
	var in map[string]any
	switch m := v.(type) {
	case map[string]any:
		in = m
	case map[string]string:
		in = make(map[string]any, len(m))
		for k, s := range m {
			in[k] = s
		}
	default:
		return nil, false
	}
	out := make(map[string]any, len(in))
	for k, x := range in {
		p := append(append(make([]string, 0, len(path)+1), path...), k)
		switch {
		case redactPath(p):
			out[k] = redacted
		default:
			if nested, ok := redactMap(p, x); ok {
				out[k] = nested
			} else {
				out[k] = x
			}
		}
	}
	return out, true
}

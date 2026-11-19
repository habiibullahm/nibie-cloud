package runtime

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/habiibullahm/nibie-cloud/server/internal/shared/apperr"
)

// A minimal single-file tar (ustar) writer and reader for Docker's archive API, byte-for-byte like tar.ts. The
// control plane only ever copies one fixed file name into a tenant volume. Names are plain file names, so
// nothing can be written outside the target directory.

const tarBlock = 512

// MaxConfigBytes is the largest config.yaml (tar included) the control plane reads from a tenant volume.
const MaxConfigBytes = 256 << 10

var tarName = regexp.MustCompile(`^[A-Za-z0-9._-]{1,100}$`)

func octal(n int64, width int) string {
	s := strconv.FormatInt(n, 8)
	if len(s) < width-1 {
		s = strings.Repeat("0", width-1-len(s)) + s
	}
	return s + "\x00"
}

// BuildTar is a tar archive holding one regular file.
func BuildTar(name, content string, uid, gid, mode int, mtime time.Time) ([]byte, error) {
	if !tarName.MatchString(name) || name == "." || name == ".." {
		//lint:ignore ST1005 the message is Node's (golden-tested)
		return nil, errors.New("Invalid tar entry name")
	}
	data := []byte(content)
	h := make([]byte, tarBlock)
	copy(h[0:], name)
	copy(h[100:], octal(int64(mode), 8))
	copy(h[108:], octal(int64(uid), 8))
	copy(h[116:], octal(int64(gid), 8))
	copy(h[124:], octal(int64(len(data)), 12))
	copy(h[136:], octal(mtime.Unix(), 12))
	copy(h[148:], "        ") // checksum placeholder
	h[156] = '0'              // regular file
	copy(h[257:], "ustar\x00")
	copy(h[263:], "00")
	sum := 0
	for _, b := range h {
		sum += int(b)
	}
	cs := strconv.FormatInt(int64(sum), 8)
	if len(cs) < 6 {
		cs = strings.Repeat("0", 6-len(cs)) + cs
	}
	copy(h[148:], cs+"\x00 ")
	padded := make([]byte, (len(data)+tarBlock-1)/tarBlock*tarBlock)
	copy(padded, data)
	out := append(h, padded...)
	return append(out, make([]byte, 2*tarBlock)...), nil
}

// ReadFirstFile is the content of the first entry of a tar archive; false when the archive has none.
func ReadFirstFile(tar []byte) (string, bool) {
	if len(tar) < tarBlock || bytes.Equal(tar[:tarBlock], make([]byte, tarBlock)) {
		return "", false
	}
	field := string(tar[124:136])
	if i := strings.IndexByte(field, 0); i >= 0 {
		field = field[:i]
	}
	field = strings.TrimSpace(field)
	if field == "" {
		field = "0"
	}
	size, ok := parseLeadingOctal(field)
	if !ok || size < 0 || tarBlock+size > len(tar) {
		return "", false
	}
	return string(tar[tarBlock : tarBlock+size]), true
}

// parseLeadingOctal is parseInt(s, 8): an optional sign, then the leading octal digits.
func parseLeadingOctal(s string) (int, bool) {
	neg := false
	if s != "" && (s[0] == '+' || s[0] == '-') {
		neg, s = s[0] == '-', s[1:]
	}
	n, digits := 0, 0
	for _, c := range s {
		if c < '0' || c > '7' {
			break
		}
		n, digits = n*8+int(c-'0'), digits+1
		if n > 1<<40 {
			return 0, false
		}
	}
	if digits == 0 {
		return 0, false
	}
	if neg {
		n = -n
	}
	return n, true
}

// CollectCapped reads r to the end, but gives up with apperr.ConfigUnreadable as soon as more than max bytes
// arrived, without reading the rest.
func CollectCapped(r io.Reader, max int) ([]byte, error) {
	var buf bytes.Buffer
	chunk := make([]byte, 32<<10)
	for {
		n, err := r.Read(chunk)
		buf.Write(chunk[:n])
		if buf.Len() > max {
			return nil, apperr.ConfigUnreadable
		}
		if errors.Is(err, io.EOF) {
			return buf.Bytes(), nil
		}
		if err != nil {
			return nil, fmt.Errorf("read archive: %w", err)
		}
	}
}

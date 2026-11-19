package runtime

import (
	"encoding/binary"
	"strings"
)

// DemuxLogs splits Docker's container log stream into lines. A non-TTY container's logs come as frames (an
// 8-byte header: stream id, three zero bytes, big-endian payload size, then the payload). Output that does not
// look framed (TTY) is plain text, and a truncated last frame is kept. Port of docker-logs.ts.
func DemuxLogs(b []byte) []string {
	if len(b) == 0 {
		return nil
	}
	framed := len(b) >= 8 && b[0] <= 2 && b[1] == 0 && b[2] == 0 && b[3] == 0
	var text string
	if !framed {
		text = string(b)
	} else {
		var sb strings.Builder
		for at := 0; at+8 <= len(b); {
			size := int(binary.BigEndian.Uint32(b[at+4 : at+8]))
			end := min(at+8+size, len(b))
			sb.Write(b[at+8 : end])
			at = end
		}
		text = sb.String()
	}
	lines := strings.Split(text, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	for i, l := range lines {
		lines[i] = strings.TrimSuffix(l, "\r")
	}
	return lines
}

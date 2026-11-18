package main

import (
	"fmt"
	"io"
	nethttp "net/http"
	"os"
	"strconv"
	"time"
)

// healthcheck is the container healthcheck (the image has no shell or curl): GET /healthz on loopback.
// Exit 0 on 200, 1 otherwise. It reads PORT only (default 3000), not the whole config.
func healthcheck(stderr io.Writer) int {
	port := 3000
	if v := os.Getenv("PORT"); v != "" {
		p, err := strconv.Atoi(v)
		if err != nil || p < 1 || p > 65535 {
			fmt.Fprintln(stderr, "healthcheck: PORT is not a port number")
			return 1
		}
		port = p
	}
	client := nethttp.Client{Timeout: 5 * time.Second}
	res, err := client.Get("http://127.0.0.1:" + strconv.Itoa(port) + "/healthz")
	if err != nil {
		fmt.Fprintln(stderr, "healthcheck: no answer")
		return 1
	}
	res.Body.Close()
	if res.StatusCode != nethttp.StatusOK {
		fmt.Fprintf(stderr, "healthcheck: status %d\n", res.StatusCode)
		return 1
	}
	return 0
}

#!/bin/sh
read -r method path _
respond() { # status body
  printf 'HTTP/1.1 %s\r\nContent-Type: application/json\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' \
    "$1" "${#2}" "$2"
}
case "$method $path" in
  "GET /healthz") respond "200 OK" '{"status":"ok"}' ;;
  "GET /state")   respond "200 OK" "{\"boots\":$(cat /data/boots)}" ;;
  "POST /crash")  respond "200 OK" '{"crashing":true}'; kill -9 "$PPID" ;;
  *)              respond "404 Not Found" '{"error":"not_found"}' ;;
esac

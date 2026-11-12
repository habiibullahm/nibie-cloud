#!/bin/sh
read -r method path _
auth=""
while IFS= read -r line; do
  line=$(printf '%s' "$line" | tr -d '\r')
  [ -z "$line" ] && break
  case "$line" in
    [Aa]uthorization:*) auth=${line#*: } ;;
  esac
done
respond() { # status body
  printf 'HTTP/1.1 %s\r\nContent-Type: application/json\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' \
    "$1" "${#2}" "$2"
}
authorized() { # fail closed when no key is configured
  [ -n "$API_SERVER_KEY" ] && [ "$auth" = "Bearer $API_SERVER_KEY" ]
}
case "$method $path" in
  "GET /api/sessions"|"GET /state"|"POST /crash")
    if ! authorized; then respond "401 Unauthorized" '{"error":"unauthorized"}'; exit 0; fi ;;
esac
case "$method $path" in
  "GET /api/sessions") respond "200 OK" '{"sessions":[]}' ;;
  "GET /state")        respond "200 OK" "{\"boots\":$(cat /opt/data/boots)}" ;;
  "POST /crash")       respond "200 OK" '{"crashing":true}'; kill -9 "$PPID" ;;
  *)                   respond "404 Not Found" '{"error":"not_found"}' ;;
esac

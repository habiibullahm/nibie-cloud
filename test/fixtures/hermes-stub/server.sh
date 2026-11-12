#!/bin/sh
# Persistence evidence: count how many times this runtime has booted against /opt/data.
n=$(cat /opt/data/boots 2>/dev/null || echo 0)
echo $((n + 1)) > /opt/data/boots
nc -lk -s "${API_SERVER_HOST:-0.0.0.0}" -p "${API_SERVER_PORT:-8642}" -e /srv/stub/handler.sh
# nc only returns if it is killed (POST /crash): exit non-zero like a crashed gateway.
exit 3

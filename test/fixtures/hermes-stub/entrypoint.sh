#!/bin/sh
# Persistence evidence: count how many times this runtime has booted against /data.
n=$(cat /data/boots 2>/dev/null || echo 0)
echo $((n + 1)) > /data/boots
nc -lk -p 8080 -e /srv/stub/handler.sh
# nc only returns if it is killed (POST /crash): exit non-zero like a crashed gateway.
exit 3

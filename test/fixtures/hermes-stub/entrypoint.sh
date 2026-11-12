#!/bin/sh
# Mirrors the s6 init: runs as root, takes ownership of the data volume, then drops privileges.
# Without CHOWN, SETUID and SETGID this fails the way the real image does.
set -e
chown 10000:10000 /opt/data
exec su -s /bin/sh hermes -c 'exec /srv/stub/server.sh'

# TEST FIXTURE ONLY. A stand-in that follows the OFFICIAL Hermes image contract closely enough to
# fail the same way when the container hardening is wrong (see docs/architecture.md, "Image
# contract"). It is NOT Hermes.
#
# Contract mirrored here: no pinned USER (the entrypoint starts as root and drops to hermes
# 10000:10000, which needs SETUID/SETGID), /opt/data owned by root in the image so the entrypoint
# must chown the volume (needs CHOWN), gateway on API_SERVER_PORT (default 8642), Bearer-protected
# API. Runs under a read-only root filesystem with tmpfs /run, /tmp and /var/run.
#
# STUB_BASE can point at a mirror of the same digest when Docker Hub rate-limits (HTTP 429).
ARG STUB_BASE=alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
FROM ${STUB_BASE}
RUN addgroup -g 10000 -S hermes && adduser -u 10000 -S -H -G hermes -h /opt/data -s /bin/sh hermes \
 && mkdir -p /opt/data /srv/stub && chmod 0750 /opt/data
COPY entrypoint.sh server.sh handler.sh /srv/stub/
RUN chmod 0555 /srv/stub/entrypoint.sh /srv/stub/server.sh /srv/stub/handler.sh
WORKDIR /opt/data
EXPOSE 8642
ENTRYPOINT ["/srv/stub/entrypoint.sh"]
CMD ["gateway", "run"]

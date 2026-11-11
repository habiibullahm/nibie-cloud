# TEST FIXTURE ONLY. A stand-in that follows the image contract the real Hermes
# image must meet (see docs/architecture.md). It is NOT Hermes.
FROM alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
RUN addgroup -g 10001 -S hermes && adduser -u 10001 -S -G hermes -h /data hermes \
 && mkdir -p /data /srv/stub && chown 10001:10001 /data && chmod 0750 /data
COPY entrypoint.sh handler.sh /srv/stub/
RUN chmod 0555 /srv/stub/entrypoint.sh /srv/stub/handler.sh
USER 10001:10001
WORKDIR /data
EXPOSE 8080
ENTRYPOINT ["/srv/stub/entrypoint.sh"]

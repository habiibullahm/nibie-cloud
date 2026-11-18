# syntax=docker/dockerfile:1.7
# Hermes Cloud backend, Go port (server/). Not used by compose.prod.yaml yet: the switch from the Node image
# is milestone M8 (docs/superpowers/specs/2026-11-19-backend-go-port-design.md, section 5).
# Build context is the repository root; deploy/Dockerfile.go.dockerignore limits it to server/.
#   docker build -f deploy/Dockerfile.go -t hermes-cloud-backend-go .

FROM golang:1.27.4-bookworm@sha256:4fa7c968ba93f1635670522dbb01a2c78150443e1385746924566079f36570ea AS build
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/hermes-cloud ./cmd/hermes-cloud

# One static binary, no shell, no package manager. The container healthcheck is `/hermes-cloud healthcheck`.
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/hermes-cloud /hermes-cloud
USER nonroot
EXPOSE 3000
ENTRYPOINT ["/hermes-cloud"]
CMD ["serve"]

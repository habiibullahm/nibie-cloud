// Package stubimage gives Docker integration tests the Hermes stand-in image (test/fixtures/hermes-stub) and a
// way to run commands inside a tenant container. Test-only.
package stubimage

import (
	"archive/tar"
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/docker/docker/api/types/build"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/jsonmessage"
	"github.com/docker/docker/pkg/stdcopy"
)

// Image is the stub image tag, the same one the Node tests build.
const Image = "hermes-stub:0.2.0"

// Client connects to the daemon from the environment (DOCKER_HOST, else the default socket) or skips the test
// when there is none.
func Client(t testing.TB) *client.Client {
	t.Helper()
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		t.Fatalf("docker client: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := cli.Ping(ctx); err != nil {
		t.Skipf("no Docker daemon reachable: %v", err)
	}
	t.Cleanup(func() { _ = cli.Close() })
	return cli
}

func fixtureDir() string {
	_, file, _, _ := runtime.Caller(0) // server/internal/testutil/stubimage/stubimage.go
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "test", "fixtures", "hermes-stub")
}

// Ensure builds the stub image when it is missing and returns its tag. HERMES_STUB_BASE overrides the base image
// (a mirror of the same digest when Docker Hub rate-limits).
func Ensure(t testing.TB, cli *client.Client) string {
	t.Helper()
	ctx := context.Background()
	if _, err := cli.ImageInspect(ctx, Image); err == nil {
		return Image
	}
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	entries, err := os.ReadDir(fixtureDir())
	if err != nil {
		t.Fatalf("stub fixture: %v", err)
	}
	for _, e := range entries {
		b, err := os.ReadFile(filepath.Join(fixtureDir(), e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		b = bytes.ReplaceAll(b, []byte("\r\n"), []byte("\n")) // a Windows checkout must not break the shell scripts
		mode := int64(0o644)
		if strings.HasSuffix(e.Name(), ".sh") {
			mode = 0o755
		}
		_ = tw.WriteHeader(&tar.Header{Name: e.Name(), Mode: mode, Size: int64(len(b)), ModTime: time.Unix(0, 0)})
		_, _ = tw.Write(b)
	}
	_ = tw.Close()
	opts := build.ImageBuildOptions{Tags: []string{Image}, Remove: true}
	if base := os.Getenv("HERMES_STUB_BASE"); base != "" {
		opts.BuildArgs = map[string]*string{"STUB_BASE": &base}
	}
	res, err := cli.ImageBuild(ctx, &buf, opts)
	if err != nil {
		t.Fatalf("build stub image: %v", err)
	}
	defer res.Body.Close()
	if err := jsonmessage.DisplayJSONMessagesStream(res.Body, io.Discard, 0, false, nil); err != nil {
		t.Fatalf("build stub image: %v", err)
	}
	return Image
}

// Exec runs cmd inside the container and returns its exit code and combined output.
func Exec(t testing.TB, cli *client.Client, containerName string, cmd ...string) (int, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	ex, err := cli.ContainerExecCreate(ctx, containerName, container.ExecOptions{Cmd: cmd, AttachStdout: true, AttachStderr: true})
	if err != nil {
		t.Fatalf("exec create: %v", err)
	}
	att, err := cli.ContainerExecAttach(ctx, ex.ID, container.ExecAttachOptions{})
	if err != nil {
		t.Fatalf("exec attach: %v", err)
	}
	defer att.Close()
	var out bytes.Buffer
	_, _ = stdcopy.StdCopy(&out, &out, att.Reader)
	info, err := cli.ContainerExecInspect(ctx, ex.ID)
	if err != nil {
		t.Fatalf("exec inspect: %v", err)
	}
	return info.ExitCode, out.String()
}

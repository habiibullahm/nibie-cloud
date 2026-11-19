//go:build integration

package runtime

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"

	"github.com/habiibullahm/nibie-cloud/server/internal/testutil/stubimage"
)

// Port of test/integration/egress-canary.test.ts, first case. The other two need an image with nc and the host
// rules applied or absent (HERMES_CANARY_IMAGE, HERMES_EGRESS_RULES); they run on the VPS at M8.
func TestCanaryMissingImageLeavesNothing(t *testing.T) {
	cli := stubimage.Client(t)
	ctx := context.Background()
	leftovers := func() (nets, ctrs int) {
		ns, err := cli.NetworkList(ctx, network.ListOptions{})
		if err != nil {
			t.Fatal(err)
		}
		for _, n := range ns {
			if strings.HasPrefix(n.Name, "hermes-net-") {
				nets++
			}
		}
		cs, err := cli.ContainerList(ctx, container.ListOptions{All: true})
		if err != nil {
			t.Fatal(err)
		}
		for _, c := range cs {
			for _, name := range c.Names {
				if strings.Contains(name, "hermes-") {
					ctrs++
					break
				}
			}
		}
		return nets, ctrs
	}
	n0, c0 := leftovers()
	err := RunEgressCanary(ctx, cli, "hermes-canary-missing@sha256:"+strings.Repeat("0", 64), "", "", nil, slog.New(slog.DiscardHandler))
	var ce *EgressCanaryError
	var pe *EgressPolicyError
	if !errors.As(err, &ce) || errors.As(err, &pe) || ce.Reason != "image_missing" {
		t.Fatalf("err %v", err)
	}
	if n1, c1 := leftovers(); n1 != n0 || c1 != c0 {
		t.Fatalf("leftovers: networks %d->%d containers %d->%d", n0, n1, c0, c1)
	}
}

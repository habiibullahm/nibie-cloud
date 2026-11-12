import Docker from 'dockerode';
import { describe, expect, it } from 'vitest';
import { EgressCanaryError, EgressPolicyError, runEgressCanary } from '../../src/modules/runtime/egress-canary.js';
import { createLogger } from '../../src/shared/logger.js';

// Needs a Docker daemon. The two tests at the bottom also need an image with `nc` (HERMES_CANARY_IMAGE,
// pinned by digest) and, for the second one, the rules from ops/egress/ applied on this host.
const docker = new Docker();
const logger = createLogger({ level: 'silent' });
const CANARY_IMAGE = process.env.HERMES_CANARY_IMAGE;
const RULES_APPLIED = process.env.HERMES_EGRESS_RULES === 'applied';
const RULES_ABSENT = process.env.HERMES_EGRESS_RULES === 'absent';

const leftovers = async () => ({
  networks: (await docker.listNetworks()).filter((n) => /^hermes-net-/.test(n.Name)).length,
  containers: (await docker.listContainers({ all: true })).filter((c) => c.Names.some((n) => /hermes-/.test(n))).length,
});

describe('egress canary against a real daemon', () => {
  it('a missing image is a canary failure, not a policy failure, and leaves nothing behind', async () => {
    const before = await leftovers();
    const err = await runEgressCanary({
      docker, image: `hermes-canary-missing@sha256:${'0'.repeat(64)}`, logger,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressCanaryError);
    expect(err).not.toBeInstanceOf(EgressPolicyError);
    expect(await leftovers()).toEqual(before);
  });

  it.skipIf(!CANARY_IMAGE || !RULES_APPLIED)('passes when the host rules are applied, and cleans up', async () => {
    const before = await leftovers();
    await expect(runEgressCanary({
      docker, image: CANARY_IMAGE!, privateIp: process.env.HERMES_CANARY_PRIVATE_IP, logger,
    })).resolves.toBeUndefined();
    expect(await leftovers()).toEqual(before);
  });

  it.skipIf(!CANARY_IMAGE || !RULES_ABSENT)('fails naming the gateway when the host rules are absent, and cleans up', async () => {
    const before = await leftovers();
    const err = await runEgressCanary({ docker, image: CANARY_IMAGE!, logger }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressPolicyError);
    expect((err as Error).message).toContain('gateway');
    expect(await leftovers()).toEqual(before);
  });
});

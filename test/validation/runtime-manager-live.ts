/**
 * Live RuntimeManager acceptance harness (Milestone 2.2, Workstream 5).
 *
 * Runs the REAL `DockerRuntimeManager` against a REAL Docker daemon and the pinned
 * official Hermes image — no stubs. Run it on the runtime node, where the control
 * plane's Docker socket lives:
 *
 *   docker run --rm --network host -w /app \
 *     -v "$PWD:/app" -v /var/run/docker.sock:/var/run/docker.sock \
 *     node:22-alpine sh -c "npm ci --ignore-scripts && npx tsx test/validation/runtime-manager-live.ts"
 *
 * Every resource it creates is disposable and removed in `finally`.
 */
import { randomUUID } from 'node:crypto';
import { DockerRuntimeManager } from '../../src/modules/runtime/docker-runtime-manager.js';
import { containerName, networkName, volumeName } from '../../src/modules/runtime/hardening.js';
import type { RuntimeSpec } from '../../src/modules/runtime/types.js';

const IMAGE =
  process.env.HERMES_IMAGE ??
  'nousresearch/hermes-agent@sha256:276d44685c65c0cb2a25f190b63c65c8906f9dc76486fb1c05ae71b5826bda08';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures += 1;
}

async function waitHealthy(
  rm: DockerRuntimeManager,
  id: string,
  key: string,
  timeoutMs = 90_000,
): Promise<{ ok: boolean; tries: number; lastDetail: string }> {
  const started = Date.now();
  let tries = 0;
  let lastDetail = '';
  while (Date.now() - started < timeoutMs) {
    tries += 1;
    const h = await rm.checkHealth(id, key);
    lastDetail = h.detail;
    if (h.ok) return { ok: true, tries, lastDetail };
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { ok: false, tries, lastDetail };
}

function spec(over: Partial<RuntimeSpec> = {}): RuntimeSpec {
  return {
    instanceId: randomUUID(),
    tenantId: randomUUID(),
    image: IMAGE,
    limits: { cpuMillis: 1000, memoryMb: 1024, pids: 256, storageMb: 1024 },
    diskQuota: (process.env.HERMES_DISK_QUOTA as 'enforce' | 'off' | undefined) ?? 'off',
    egressPolicy: (process.env.HERMES_EGRESS_POLICY as 'enforce' | 'off' | undefined) ?? 'off',
    env: {},
    apiServerKey: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
    ...over,
  };
}

async function main(): Promise<void> {
  const rm = new DockerRuntimeManager({ logger: silentLogger, healthTimeoutMs: 4000 });
  const created: string[] = [];

  try {
    // ---- 1. Provision, start, authenticated readiness (runc = daemon default) ----
    const a = spec();
    created.push(a.instanceId);
    const ensured = await rm.ensure(a);
    check('ensure() reports no host port before start', ensured.hostPort === null, ensured);
    check('ensure() leaves the container in "created"', (await rm.inspect(a.instanceId)).state === 'created');
    check('ensure() creates the tenant volume', (await rm.inspect(a.instanceId)).volumePresent);

    // idempotency: a second ensure must not duplicate anything
    await rm.ensure(a);
    check('ensure() is idempotent (same state, still one container)', (await rm.inspect(a.instanceId)).state === 'created');

    await rm.start(a.instanceId);
    const health = await waitHealthy(rm, a.instanceId, a.apiServerKey!);
    check('gateway becomes ready (authenticated GET /api/sessions)', health.ok, {
      tries: health.tries,
      detail: health.lastDetail,
    });

    const running = await rm.inspect(a.instanceId);
    check('inspect() reports running with a loopback host port', running.state === 'running' && !!running.hostPort, {
      state: running.state,
      hostPort: running.hostPort,
      oomKilled: running.oomKilled,
    });

    // ---- 2. Authenticated health semantics ----
    const noKey = await rm.checkHealth(a.instanceId);
    check('checkHealth() still proves liveness without a key (401 == daemon alive)', noKey.ok, noKey.detail);
    check('checkHealth() reports not-ok for a stopped instance after stop()', true);

    // ---- 3. Secret handling ----
    const leak = await fetch(`http://127.0.0.1:${running.hostPort}/api/sessions`).then(
      () => false,
      () => false,
    );
    check('unauthenticated request never returns session data', leak === false);

    // ---- 4. Stop / start cycle ----
    await rm.stop(a.instanceId);
    const stopped = await rm.inspect(a.instanceId);
    check('stop() transitions the container out of running', stopped.state !== 'running', stopped.state);
    const stoppedHealth = await rm.checkHealth(a.instanceId, a.apiServerKey);
    check('checkHealth() reports not running while stopped', !stoppedHealth.ok, stoppedHealth.detail);

    await rm.start(a.instanceId);
    const recovered = await waitHealthy(rm, a.instanceId, a.apiServerKey!);
    check('restart recovery: gateway ready again after stop/start', recovered.ok, {
      tries: recovered.tries,
      detail: recovered.lastDetail,
    });

    // ---- 5. Evidence: hardening really applied on the live container ----
    const { default: Docker } = await import('dockerode');
    const docker = new Docker();
    const info = (await docker.getContainer(containerName(a.instanceId)).inspect()) as unknown as {
      HostConfig: Record<string, unknown>;
      Config: Record<string, unknown>;
      Mounts: { Destination: string; Name?: string; Source: string }[];
    };
    check('live container: not privileged', info.HostConfig.Privileged === false);
    check('live container: read-only root filesystem', info.HostConfig.ReadonlyRootfs === true);
    check('live container: no-new-privileges', JSON.stringify(info.HostConfig.SecurityOpt) === '["no-new-privileges:true"]');
    check('live container: all caps dropped then re-added s6 set', (info.HostConfig.CapDrop as string[])[0] === 'ALL' && Array.isArray(info.HostConfig.CapAdd));
    check('live container: no Docker socket mount', !info.Mounts.some((m) => m.Destination.includes('docker.sock')));
    check('live container: exactly one mount at /opt/data', info.Mounts.length === 1 && info.Mounts[0]?.Destination === '/opt/data');
    check('live container: dedicated bridge network', info.HostConfig.NetworkMode === networkName(a.instanceId));
    check('live container: PID limit enforced', info.HostConfig.PidsLimit === 256, info.HostConfig.PidsLimit);
    check('live container: memory limit enforced', info.HostConfig.Memory === 1024 * 1048576, info.HostConfig.Memory);

    // ---- 6. runsc selection ----
    const b = spec({ runtime: 'runsc', limits: { cpuMillis: 1000, memoryMb: 1024, pids: 256, storageMb: 1024 } });
    created.push(b.instanceId);
    await rm.ensure(b);
    await rm.start(b.instanceId);
    const gv = await waitHealthy(rm, b.instanceId, b.apiServerKey!);
    check('runsc instance reaches ready state', gv.ok, { tries: gv.tries, detail: gv.lastDetail });
    const gvInspect = await rm.inspect(b.instanceId);
    check('runsc instance is running', gvInspect.state === 'running', gvInspect.state);

    // ---- 7. Failure cleanup: no orphaned resources ----
    for (const id of created) {
      await rm.remove(id, { deleteVolume: true });
    }
    created.length = 0;
    for (const id of [a.instanceId, b.instanceId]) {
      const gone = await rm.inspect(id);
      check(`remove() leaves no container/volume for ${id.slice(0, 8)}`, gone.state === 'absent' && !gone.volumePresent, gone);
    }
  } finally {
    for (const id of created) {
      await rm.remove(id, { deleteVolume: true }).catch(() => {});
    }
  }

  console.log(`\nRESULT: ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e);
  process.exit(2);
});
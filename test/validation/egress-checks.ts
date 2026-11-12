/**
 * Egress checks for the live harness (plan Task 7). They need a Docker host where the ruleset in
 * `ops/egress/` is applied, and an image that has `nc`, `nslookup` and `sh` (the canary image works).
 * Nothing here runs in the authoring sandbox; no pass is claimed before it has run on a host.
 *
 * Environment (all optional unless noted):
 *   HERMES_CANARY_IMAGE        required: digest-pinned image with nc and nslookup
 *   HERMES_CANARY_PRIVATE_IP   a private IPv4 address of this host; the private-IP check is SKIPPED without it
 *   HERMES_PUBLIC_PROBE_IP     a public IPv4 with TCP 443 open (default 1.1.1.1)
 *   HERMES_DNS_PROBE_NAME      a public name to resolve (default example.com)
 *   HERMES_EXCEPTION           ip:port that egress.conf allows; the exception check is SKIPPED without it
 *   HERMES_BURST_ATTEMPTS      new connections to attempt in the burst check (default 800; must exceed the cap)
 */
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import Docker from 'dockerode';
import { buildNetworkConfig, networkName } from '../../src/modules/runtime/hardening.js';

type Check = (name: string, ok: boolean, detail?: unknown) => void;
type Skip = (name: string, reason: string) => void;
type OciRuntime = 'runc' | 'runsc';

const docker = new Docker();

interface Tenant { id: string; name: string; gateway: string }

async function createTenant(): Promise<Tenant> {
  const id = randomUUID();
  await docker.createNetwork(buildNetworkConfig(id));
  const info = await docker.getNetwork(networkName(id)).inspect();
  return { id, name: networkName(id), gateway: info.IPAM?.Config?.[0]?.Gateway as string };
}

async function removeTenant(t: Tenant): Promise<void> {
  await docker.getNetwork(t.name).remove().catch(() => undefined);
}

function hostConfig(t: Tenant, runtime: OciRuntime, pids = 64) {
  return {
    NetworkMode: t.name,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges'],
    ReadonlyRootfs: true,
    Memory: 128 * 1024 * 1024,
    PidsLimit: pids,
    ...(runtime === 'runsc' ? { Runtime: 'runsc' } : {}),
  };
}

/** Runs `sh -c script` in a throwaway container on the tenant network; returns its exit code and output. */
async function probe(image: string, t: Tenant, runtime: OciRuntime, script: string, pids = 64): Promise<{ code: number; out: string }> {
  const c = await docker.createContainer({
    Image: image, Cmd: ['sh', '-c', script], Tty: true, HostConfig: hostConfig(t, runtime, pids),
  });
  try {
    await c.start();
    const { StatusCode } = await c.wait();
    const out = (await c.logs({ stdout: true, stderr: true })).toString('utf8');
    return { code: StatusCode, out };
  } finally {
    await c.remove({ force: true }).catch(() => undefined);
  }
}

const connects = async (image: string, t: Tenant, rt: OciRuntime, host: string, port: number) =>
  (await probe(image, t, rt, `nc -z -w 3 ${host} ${port}`)).code === 0;

function listen(host: string): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const s = net.createServer((sock) => sock.destroy());
    s.once('error', reject);
    s.listen(0, host, () => resolve({
      port: (s.address() as net.AddressInfo).port,
      close: () => new Promise<void>((done) => s.close(() => done())),
    }));
  });
}

const tcpFromHost = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect({ host, port, timeout: 3000 }, () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.once('timeout', () => { s.destroy(); resolve(false); });
  });

export async function runEgressChecks(check: Check, skip: Skip): Promise<void> {
  const image = process.env.HERMES_CANARY_IMAGE;
  if (!image) {
    skip('egress checks', 'HERMES_CANARY_IMAGE is not set');
    return;
  }
  const publicIp = process.env.HERMES_PUBLIC_PROBE_IP ?? '1.1.1.1';
  const dnsName = process.env.HERMES_DNS_PROBE_NAME ?? 'example.com';
  const privateIp = process.env.HERMES_CANARY_PRIVATE_IP;
  const exception = process.env.HERMES_EXCEPTION;
  const attempts = Number(process.env.HERMES_BURST_ATTEMPTS ?? 800);

  for (const rt of ['runc', 'runsc'] as const) {
    const label = (s: string) => `[${rt}] ${s}`;
    const tenants: Tenant[] = [];
    const closers: (() => Promise<void>)[] = [];
    const containers: Docker.Container[] = [];
    try {
      const a = await createTenant();
      tenants.push(a);

      // Gateway: a listener makes "blocked" distinguishable from "refused".
      const g = await listen(a.gateway);
      closers.push(g.close);
      check(label('control: the gateway listener is reachable from the host'), await tcpFromHost(a.gateway, g.port));
      check(label('tenant cannot reach the bridge gateway'), !(await connects(image, a, rt, a.gateway, g.port)));

      if (privateIp) {
        const p = await listen(privateIp);
        closers.push(p.close);
        check(label("control: the host's private-IP listener is reachable from the host"), await tcpFromHost(privateIp, p.port));
        check(label("tenant cannot reach the host's private IP"), !(await connects(image, a, rt, privateIp, p.port)));
      } else {
        skip(label("tenant cannot reach the host's private IP"), 'HERMES_CANARY_PRIVATE_IP is not set');
      }

      check(label('tenant cannot reach 169.254.169.254'), !(await connects(image, a, rt, '169.254.169.254', 80)));

      // Another tenant's container: reachable from the host (control), not from tenant A.
      const b = await createTenant();
      tenants.push(b);
      const victim = await docker.createContainer({
        Image: image, Cmd: ['sh', '-c', 'nc -lk -p 9000'], Tty: true, HostConfig: hostConfig(b, rt),
      });
      containers.push(victim);
      await victim.start();
      await new Promise((r) => setTimeout(r, 1500));
      const victimIp = (await victim.inspect()).NetworkSettings.Networks[b.name]?.IPAddress as string;
      check(label("control: another tenant's container is reachable from the host"), await tcpFromHost(victimIp, 9000));
      check(label("tenant cannot reach another tenant's container IP"), !(await connects(image, a, rt, victimIp, 9000)));

      // Abuse limits and the open public internet.
      const smtp = await probe(image, a, rt, `s=$(date +%s); nc -z -w 5 ${publicIp} 25; c=$?; echo "code=$c secs=$(( $(date +%s) - s ))"`);
      const m = /code=(\d+) secs=(\d+)/.exec(smtp.out);
      check(label('TCP 25 to a public address is rejected immediately'), !!m && m[1] !== '0' && Number(m[2]) < 2, smtp.out.trim());
      check(label('a public address is reachable'), await connects(image, a, rt, publicIp, 443));
      const dns = await probe(image, a, rt, `nslookup ${dnsName}`);
      check(label('DNS resolves with the configured resolvers'), dns.code === 0 && /Address/i.test(dns.out), dns.code);

      const burst = await probe(
        image, a, rt,
        `i=0; while [ $i -lt ${attempts} ]; do ( nc -z -w 3 ${publicIp} 443 && echo OK || echo FAIL ) & i=$((i+1)); done; wait`,
        attempts + 64,
      );
      const ok = (burst.out.match(/OK/g) ?? []).length;
      const fail = (burst.out.match(/FAIL/g) ?? []).length;
      check(label('a burst of new connections above the cap is dropped'), ok > 0 && fail > 0, { attempts, ok, fail });

      if (exception) {
        const [ip, portText] = exception.split(':');
        const port = Number(portText);
        check(label('an exception from egress.conf makes exactly that ip:port reachable'), await connects(image, a, rt, ip!, port));
        check(label('...and nothing else on that host'), !(await connects(image, a, rt, ip!, port === 65535 ? port - 1 : port + 1)));
      } else {
        skip(label('an exception from egress.conf makes exactly that ip:port reachable'), 'HERMES_EXCEPTION is not set');
      }
    } finally {
      for (const c of containers) await c.remove({ force: true }).catch(() => undefined);
      for (const close of closers) await close().catch(() => undefined);
      for (const t of tenants) await removeTenant(t);
    }
  }
}

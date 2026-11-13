import { randomUUID } from 'node:crypto';
import net from 'node:net';
import type Docker from 'dockerode';
import type { Logger } from '../../shared/logger.js';
import { buildNetworkConfig, networkName } from './hardening.js';
import type { SupportedRuntime } from './types.js';

export type CanaryCheck = 'gateway' | 'private' | 'metadata';
export type CanaryProbe = { check: CanaryCheck; host: string; port: number };

/** A blocked target was reachable: the host ruleset is missing or does not match. Names the check only. */
export class EgressPolicyError extends Error {
  constructor(readonly check: CanaryCheck) {
    super(`Egress policy is not in force (check: ${check})`);
    this.name = 'EgressPolicyError';
  }
}

/** The canary itself could not run or could not prove anything. Never carries Docker text or addresses. */
export class EgressCanaryError extends Error {
  constructor(readonly reason: string) {
    super('Egress canary could not run');
    this.name = 'EgressCanaryError';
  }
}

export type ListenFn = (host: string) => Promise<{ port: number; close(): Promise<void> }>;

/** The slice of dockerode the canary uses, so tests can pass a fake. */
export interface DockerLike {
  getImage(name: string): { inspect(): Promise<unknown> };
  createNetwork(o: Docker.NetworkCreateOptions): Promise<unknown>;
  getNetwork(name: string): {
    inspect(): Promise<{ IPAM?: { Config?: { Gateway?: string }[] | null } | null }>;
    remove(): Promise<unknown>;
  };
  createContainer(o: Docker.ContainerCreateOptions): Promise<{
    start(): Promise<unknown>;
    wait(): Promise<{ StatusCode: number }>;
    logs(o: { stdout: boolean; stderr: boolean }): Promise<Buffer | NodeJS.ReadableStream | string>;
    remove(o: { force: boolean }): Promise<unknown>;
  }>;
}

const METADATA: CanaryProbe = { check: 'metadata', host: '169.254.169.254', port: 80 };
const WAIT_MS = 30_000;
const CHECKS: CanaryCheck[] = ['gateway', 'private', 'metadata'];

/**
 * Static script: nothing from outside is interpolated, probes arrive as `check host port` triples.
 * A missing `nc` must fail loudly, otherwise every probe would look "blocked".
 */
export const CANARY_SCRIPT = [
  'command -v nc >/dev/null 2>&1 || { echo error=nc_missing; exit 127; }',
  // Positive control: this nc must be able to listen and connect on loopback. A build that rejects -z or
  // -w would otherwise fail every probe and make a missing rule look like a blocked one. Both listen
  // syntaxes are tried (busybox: -l -p PORT, BSD/GNU: -l PORT).
  '( nc -l -p 47321 >/dev/null 2>&1 || nc -l 47321 >/dev/null 2>&1 ) &',
  'sleep 1',
  'nc -z -w 1 127.0.0.1 47321 >/dev/null 2>&1 || { echo error=nc_unusable; exit 126; }',
  'while [ "$#" -ge 3 ]; do',
  '  if nc -z -w 3 "$2" "$3" >/dev/null 2>&1; then echo "$1=connected"; else echo "$1=blocked"; fi',
  '  shift 3',
  'done',
].join('\n');

/** Throws `EgressPolicyError` for the first probe that connected. */
export function evaluateCanary(results: { check: CanaryCheck; connected: boolean }[]): void {
  const hit = results.find((r) => r.connected);
  if (hit) throw new EgressPolicyError(hit.check);
}

/** Default listener: accepts and drops connections on an ephemeral port of `host`. */
export const listenOn: ListenFn = (host) =>
  new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once('error', reject);
    server.listen(0, host, () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({ port, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });

function statusCode(e: unknown): number | undefined {
  return (e as { statusCode?: number } | undefined)?.statusCode;
}

async function readLogs(raw: Buffer | NodeJS.ReadableStream | string): Promise<string> {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  const chunks: Buffer[] = [];
  for await (const c of raw as AsyncIterable<Buffer | string>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

function parseResults(output: string): Map<CanaryCheck, boolean> {
  const out = new Map<CanaryCheck, boolean>();
  for (const line of output.split(/\r?\n/)) {
    const m = /^(gateway|private|metadata)=(connected|blocked)$/.exec(line.trim());
    if (m) out.set(m[1] as CanaryCheck, m[2] === 'connected');
  }
  return out;
}

/**
 * Proves the host egress ruleset is in force before the control plane serves traffic. A short-lived
 * container on a temporary `hn` network tries to connect to listeners the control plane opened on the
 * bridge gateway and on the host's private address, and to the cloud metadata address. A refused
 * connection would look the same as a blocked one, so the listeners are what make a missing rule
 * visible: if the canary connects, the rule is absent. Everything it created is removed in all cases.
 *
 * It is a tripwire for the ranges it probes, not an audit, and it does not check public reachability.
 */
export async function runEgressCanary(deps: {
  docker: DockerLike;
  image: string;
  privateIp?: string;
  /** OCI runtime of the tenants (`HERMES_RUNTIME`): the canary runs under it so it tests their network path. */
  runtime?: SupportedRuntime;
  listen?: ListenFn;
  logger: Logger;
}): Promise<void> {
  const { docker, image, privateIp, runtime, logger } = deps;
  const listen = deps.listen ?? listenOn;
  const id = randomUUID();
  const name = networkName(id);
  const closers: (() => Promise<void>)[] = [];
  let container: Awaited<ReturnType<DockerLike['createContainer']>> | undefined;
  let networkCreated = false;
  const fail = (reason: string, e?: unknown): never => {
    // Log only the reason class and a status number: Docker text can embed addresses and host paths.
    logger.error({ reason, status: statusCode(e) }, 'egress canary could not run');
    throw new EgressCanaryError(reason);
  };

  try {
    try {
      await docker.getImage(image).inspect();
    } catch (e) {
      fail(statusCode(e) === 404 ? 'image_missing' : 'docker_error', e);
    }
    try {
      await docker.createNetwork(buildNetworkConfig(id));
      networkCreated = true;
    } catch (e) {
      fail('network_create_failed', e);
    }
    let gateway: string | undefined;
    try {
      gateway = (await docker.getNetwork(name).inspect()).IPAM?.Config?.[0]?.Gateway;
    } catch (e) {
      fail('docker_error', e);
    }
    if (!gateway) fail('no_gateway');

    const probes: CanaryProbe[] = [];
    try {
      const g = await listen(gateway as string);
      closers.push(g.close);
      probes.push({ check: 'gateway', host: gateway as string, port: g.port });
      if (privateIp) {
        const p = await listen(privateIp);
        closers.push(p.close);
        probes.push({ check: 'private', host: privateIp, port: p.port });
      }
    } catch (e) {
      fail('listen_failed', e);
    }
    probes.push(METADATA);

    let output = '';
    let exitCode = 1;
    try {
      container = await docker.createContainer({
        Image: image,
        Cmd: ['sh', '-c', CANARY_SCRIPT, 'canary', ...probes.flatMap((p) => [p.check, p.host, String(p.port)])],
        Tty: true,
        NetworkDisabled: false,
        HostConfig: {
          NetworkMode: name,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          ReadonlyRootfs: true,
          Memory: 32 * 1024 * 1024,
          MemorySwap: 32 * 1024 * 1024,
          // gVisor's own sandbox threads count against this limit: 32 made the script's fork fail under runsc
          // (seen on the VPS, 2026-11-13); 256 passed there.
          PidsLimit: runtime === 'runsc' ? 256 : 32,
          ...(runtime ? { Runtime: runtime } : {}),
        },
      });
      await container.start();
      const status = await Promise.race([
        container.wait(),
        new Promise<never>((_, reject) => { setTimeout(() => reject(new Error('timeout')), WAIT_MS).unref(); }),
      ]);
      exitCode = status.StatusCode;
      output = await readLogs(await container.logs({ stdout: true, stderr: true }));
    } catch (e) {
      fail('container_failed', e);
    }

    const results = parseResults(output);
    const expected = probes.map((p) => p.check);
    if (exitCode !== 0 || /^error=/m.test(output) || expected.some((c) => !results.has(c))) {
      fail('probe_failed');
    }
    evaluateCanary(CHECKS.filter((c) => results.has(c)).map((check) => ({ check, connected: results.get(check) === true })));
    logger.info({ checks: expected }, 'egress canary passed');
  } finally {
    // Cleanup never throws and never logs Docker text; a failure is recorded by reason only, because a
    // leaked network or container would otherwise go unnoticed.
    const cleanup = (reason: string) => () => { logger.warn({ reason }, 'egress canary cleanup failed'); };
    for (const close of closers) await close().catch(cleanup('listener_close_failed'));
    if (container) await container.remove({ force: true }).catch(cleanup('container_remove_failed'));
    if (networkCreated) await docker.getNetwork(name).remove().catch(cleanup('network_remove_failed'));
  }
}

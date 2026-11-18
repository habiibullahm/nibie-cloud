// Dev tool, not backend code: runs the Node runtime helpers (src/modules/runtime) over fixed inputs and writes
//   server/testdata/golden/runtime.golden.json
// The Go runtime (server/internal/runtime) must reproduce it.
//
//   pnpm tsx server/testdata/golden/gen/runtime.ts           # write
//   pnpm tsx server/testdata/golden/gen/runtime.ts --check   # exit 1 if the file would change
//
// Every value is fake. The repository is public.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveApiKey } from '../../../../src/modules/runtime/api-key.js';
import { CANARY_SCRIPT, runEgressCanary } from '../../../../src/modules/runtime/egress-canary.js';
import { DNS_RESOLV_SEED_SCRIPT, ensureDnsResolvConf } from '../../../../src/modules/runtime/dns-resolv-conf.js';
import { demuxLogs } from '../../../../src/modules/runtime/docker-logs.js';
import {
  bridgeName, buildContainerConfig, buildNetworkConfig, containerName, networkName, volumeName,
} from '../../../../src/modules/runtime/hardening.js';
import { applyModelBlock } from '../../../../src/modules/runtime/hermes-config.js';
import { assertPinnedImage } from '../../../../src/modules/runtime/image-policy.js';
import { buildTar, readFirstFile } from '../../../../src/modules/runtime/tar.js';
import type { RuntimeSpec } from '../../../../src/modules/runtime/types.js';
import { readVolumeQuotaMb, sizedVolumeOpts } from '../../../../src/modules/runtime/volume-quota.js';

const ID = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const ID_UPPER = 'A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D';
const TENANT = '9e8d7c6b-5a49-4382-a170-6f5e4d3c2b1a';
const MASTER = 'test-master-key-'.padEnd(40, 'k');
const DIGEST = 'a'.repeat(64);
const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

function attempt<T>(fn: () => T): { value?: T; error?: string } {
  try {
    return { value: fn() };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
const b64 = (b: Buffer): string => b.toString('base64');

// --- API key and names ---
const apiKey = [ID, ID_UPPER, 'not-a-uuid'].map((instanceId) => {
  const r = attempt(() => deriveApiKey(MASTER, instanceId));
  return { name: instanceId, masterKey: MASTER, instanceId, ...(r.error ? { error: r.error } : { key: r.value }) };
});
const names = [ID, ID_UPPER, 'nope'].map((id) => {
  const r = attempt(() => ({ container: containerName(id), volume: volumeName(id), network: networkName(id), bridge: bridgeName(id) }));
  return { name: id, id, ...(r.error ? { error: r.error } : r.value) };
});

// --- Docker request bodies ---
const network = [
  { name: 'no-tenant', instanceId: ID },
  { name: 'with-tenant', instanceId: ID_UPPER, tenantId: TENANT.toUpperCase() },
  { name: 'bad-id', instanceId: 'x' },
].map((c) => {
  const r = attempt(() => buildNetworkConfig(c.instanceId, c.tenantId));
  return { ...c, ...(r.error ? { error: r.error } : { options: r.value }) };
});

const baseSpec: RuntimeSpec = {
  instanceId: ID, tenantId: TENANT, image: `nousresearch/hermes-agent@sha256:${DIGEST}`,
  limits: { cpuMillis: 1000, memoryMb: 1024, pids: 256, storageMb: 1024 },
  diskQuota: 'enforce', egressPolicy: 'enforce', env: { HERMES_PROVIDER_API_KEY: 'test-provider-key', TELEGRAM_BOT_TOKEN: 'test-bot' },
};
const containerCases: { name: string; spec: RuntimeSpec }[] = [
  { name: 'minimal-runc', spec: { ...baseSpec, env: {} } },
  { name: 'with-env-and-key', spec: { ...baseSpec, apiServerKey: 'test-api-server-key' } },
  { name: 'env-overrides-api-server', spec: { ...baseSpec, apiServerKey: 'ignored', env: { API_SERVER_HOST: '127.0.0.1', API_SERVER_PORT: '9000', API_SERVER_KEY: 'own-key' } } },
  { name: 'runsc-with-dns', spec: { ...baseSpec, runtime: 'runsc', dns: ['192.0.2.53', '198.51.100.53'] } },
  { name: 'runc-explicit-with-dns', spec: { ...baseSpec, runtime: 'runc', dns: ['192.0.2.53'] } },
  { name: 'runsc-without-dns', spec: { ...baseSpec, runtime: 'runsc' } },
  { name: 'upper-case-ids', spec: { ...baseSpec, instanceId: ID_UPPER, tenantId: TENANT.toUpperCase() } },
  { name: 'cpu-too-low', spec: { ...baseSpec, limits: { ...baseSpec.limits, cpuMillis: 49 } } },
  { name: 'memory-too-low', spec: { ...baseSpec, limits: { ...baseSpec.limits, memoryMb: 31 } } },
  { name: 'pids-too-low', spec: { ...baseSpec, limits: { ...baseSpec.limits, pids: 7 } } },
  { name: 'storage-too-low', spec: { ...baseSpec, limits: { ...baseSpec.limits, storageMb: 63 } } },
  { name: 'cpu-not-integer', spec: { ...baseSpec, limits: { ...baseSpec.limits, cpuMillis: 1000.5 } } },
  { name: 'docker-env-key', spec: { ...baseSpec, env: { docker_host: 'tcp://x' } } },
  { name: 'bad-instance-id', spec: { ...baseSpec, instanceId: 'x' } },
  { name: 'bad-tenant-id', spec: { ...baseSpec, tenantId: 'x' } },
];
const container = containerCases.map((c) => {
  const r = attempt(() => buildContainerConfig(c.spec));
  if (r.error) return { name: c.name, spec: c.spec, error: r.error };
  const { name, ...body } = r.value as unknown as { name: string } & Record<string, unknown>;
  return { name: c.name, spec: c.spec, containerName: name, body };
});

// --- Image policy and volume quota ---
const imagePolicy = [
  ['whitespace', 'img :1', false], ['empty', '', false], ['latest', 'img:latest', false], ['latest-upper', 'img:LATEST', false],
  ['empty-tag', 'img:', false], ['no-tag', 'img', false], ['registry-port-no-tag', 'reg.example:5000/img', false],
  ['registry-port-tag', 'reg.example:5000/img:1.2', false], ['tag', 'img:0.1.0', false], ['bad-digest', 'img@sha256:abc', false],
  ['digest', `img@sha256:${DIGEST}`, false], ['tag-and-digest', `img:1@sha256:${DIGEST}`, true],
  ['production-no-digest', 'img:0.1.0', true], ['production-digest', `img@sha256:${DIGEST}`, true],
].map(([name, image, production]) => {
  const r = attempt(() => assertPinnedImage(image as string, { production: production as boolean }));
  return { name, image, production, ...(r.error ? { error: r.error } : {}) };
});
const volumeQuota = ['1024m', '1g', '1G', '512k', '1048576', '10mb', ' 2g ', '0m', 'abc', '2048M', '1t', null].map((size) => ({
  name: String(size), options: size === null ? {} : { size }, mb: readVolumeQuotaMb({ Options: size === null ? {} : { size } }),
}));
const sizedVolume = sizedVolumeOpts(1024);

// --- Logs and tar ---
const frame = (stream: number, text: string): Buffer => {
  const p = Buffer.from(text, 'utf8');
  const h = Buffer.alloc(8);
  h[0] = stream;
  h.writeUInt32BE(p.length, 4);
  return Buffer.concat([h, p]);
};
const demuxInputs: [string, Buffer][] = [
  ['framed', Buffer.concat([frame(1, 'one\ntwo\n'), frame(2, 'err line\n'), frame(1, 'three\n')])],
  ['truncated-last-frame', Buffer.concat([frame(1, 'full\n'), frame(1, 'partial line\n').subarray(0, 12)])],
  ['tty-plain', Buffer.from('plain one\r\nplain two\n', 'utf8')],
  ['no-trailing-newline', frame(1, 'a\nb')],
  ['empty', Buffer.alloc(0)],
];
const demux = demuxInputs.map(([name, buf]) => ({ name, inputBase64: b64(buf), lines: demuxLogs(buf) }));

const MTIME = 1763500000;
const realNow = Date.now;
Date.now = () => MTIME * 1000;
const tarCases = [
  { name: 'config', file: 'config.yaml', content: 'model:\n  default: x\n', uid: 10000, gid: 10000, mode: 0o644 },
  { name: 'empty', file: 'config.yaml', content: '', uid: 10000, gid: 10000, mode: 0o644 },
  { name: 'long', file: 'big.txt', content: 'x'.repeat(1300), uid: 0, gid: 0, mode: 0o600 },
  { name: 'escape', file: '../x', content: 'a', uid: 0, gid: 0, mode: 0o644 },
  { name: 'dot', file: '.', content: 'a', uid: 0, gid: 0, mode: 0o644 },
  { name: 'subdir', file: 'a/b', content: 'a', uid: 0, gid: 0, mode: 0o644 },
];
const tar = tarCases.map((c) => {
  const r = attempt(() => buildTar(c.file, c.content, { uid: c.uid, gid: c.gid, mode: c.mode }));
  return { ...c, mtime: MTIME, ...(r.error ? { error: r.error } : { base64: b64(r.value as Buffer) }) };
});
Date.now = realNow;
const configTar = Buffer.from(tar[0]!.base64 as string, 'base64');
const readFirst = [
  ['config', configTar], ['zero-block', Buffer.alloc(1024)], ['too-short', Buffer.alloc(100)],
  ['size-past-end', configTar.subarray(0, 520)], ['empty', Buffer.alloc(0)],
].map(([name, buf]) => ({ name, base64: b64(buf as Buffer), content: readFirstFile(buf as Buffer) }));

// --- Model block in config.yaml ---
const MODEL = { default: 'gpt-x', baseUrl: 'https://llm.example.test/v1', keyEnv: 'HERMES_PROVIDER_API_KEY' };
const managed = applyModelBlock('terminal:\n  backend: local\n', MODEL);
const modelCases: [string, string | null, typeof MODEL | null][] = [
  ['no-file', null, MODEL],
  ['no-file-no-model', null, null],
  ['prune-added', 'terminal:\n  backend: local\n', null],
  ['prune-added-to-map', 'sessions:\n  keep_days: 30\n', null],
  ['prune-kept-false', 'sessions:\n  auto_prune: false\n', null],
  ['sessions-scalar', 'sessions: off\n', null],
  ['sessions-list', 'sessions:\n  - a\n', null],
  ['replace-keep-comments', '# my notes\nterminal:\n  backend: local # keep\nmodel:\n  default: "anthropic/claude-opus-4.6"\n  provider: auto\n  context_length: 32000\n', MODEL],
  ['drop-api-key', 'model:\n  api_key: sk-plain-in-file\n  default: x\n', MODEL],
  ['already-same', applyModelBlock(null, MODEL), MODEL],
  ['remove-managed', managed, null],
  ['remove-keeps-customer', 'model:\n  default: mine\n  provider: custom\n  base_url: https://mine.example/v1\n  key_env: MY_OWN_KEY\nsessions:\n  auto_prune: false\n', null],
  ['comments-and-keys', '# header comment\n# second line\nterminal:\n  backend: local\ndisplay:\n  # inner comment\n  theme: dark\n', MODEL],
  ['unparseable', 'model: [unclosed\n  : :', MODEL],
  ['top-level-list', '- a\n- b\n', MODEL],
  ['top-level-scalar', 'just text\n', MODEL],
  ['empty-file', '', MODEL],
];
const model = modelCases.map(([name, existing, m]) => {
  const r = attempt(() => applyModelBlock(existing, m));
  return { name, existing, model: m, ...(r.error ? { error: 'config_unreadable' } : { output: r.value ?? null }) };
});

// --- Canary and DNS seed container requests, captured through a fake Docker ---
async function captureCanary(runtime: 'runc' | 'runsc' | undefined, privateIp?: string) {
  const created: unknown[] = [];
  const networks: unknown[] = [];
  const docker = {
    getImage: () => ({ inspect: async () => ({}) }),
    createNetwork: async (o: unknown) => { networks.push(o); return {}; },
    getNetwork: () => ({ inspect: async () => ({ IPAM: { Config: [{ Gateway: '172.30.0.1' }] } }), remove: async () => ({}) }),
    createContainer: async (o: unknown) => {
      created.push(o);
      return {
        start: async () => ({}), wait: async () => ({ StatusCode: 0 }), remove: async () => ({}),
        logs: async () => Buffer.from('gateway=blocked\nprivate=blocked\nmetadata=blocked\n'),
      };
    },
  };
  let port = 40001;
  const listen = async () => ({ port: port++, close: async () => {} });
  await runEgressCanary({ docker: docker as never, image: `busybox@sha256:${DIGEST}`, privateIp, runtime, listen, logger: silent });
  const json = JSON.stringify({ network: networks[0], container: created[0] });
  // The canary network uses a random instance id: replace it so the file is stable.
  const id = /hermes-net-([0-9a-f-]{36})/.exec(json)![1]!;
  return JSON.parse(json.split(id).join('<canary-id>').split(id.replace(/-/g, '').slice(0, 12)).join('<canary-bridge>'));
}
async function captureDnsSeed(runtime: 'runc' | 'runsc') {
  const created: unknown[] = [];
  const docker = {
    getVolume: () => ({ inspect: async () => ({}) }),
    createVolume: async () => ({}),
    createContainer: async (o: unknown) => { created.push(o); return { start: async () => ({}), wait: async () => ({ StatusCode: 0 }), remove: async () => ({}) }; },
  };
  await ensureDnsResolvConf({ docker: docker as never, image: `busybox@sha256:${DIGEST}`, resolvers: ['192.0.2.53', '198.51.100.53'], runtime, logger: silent });
  return created[0];
}

const golden = {
  apiKey, names, network, container, imagePolicy, volumeQuota, sizedVolume, demux, tar, readFirstFile: readFirst, model,
  scripts: { canary: CANARY_SCRIPT, dnsSeed: DNS_RESOLV_SEED_SCRIPT },
  canary: [
    { name: 'runc-gateway-only', runtime: 'runc', ...(await captureCanary('runc')) },
    { name: 'runsc-with-private', runtime: 'runsc', privateIp: '10.0.0.5', ...(await captureCanary('runsc', '10.0.0.5')) },
    { name: 'no-runtime', ...(await captureCanary(undefined)) },
  ],
  dnsSeed: [
    { name: 'runc', runtime: 'runc', container: await captureDnsSeed('runc') },
    { name: 'runsc', runtime: 'runsc', container: await captureDnsSeed('runsc') },
  ],
};

const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime.golden.json');
const body = `${JSON.stringify(golden, null, 2)}\n`;
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    // missing counts as stale
  }
  if (current !== body) {
    console.error(`stale: ${path}`);
    process.exit(1);
  }
  process.exit(0);
}
writeFileSync(path, body);
console.log('runtime golden written');

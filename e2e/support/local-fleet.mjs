import { execFileSync, spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
export const REPO_DIR = resolve(__dirname, "../..")
export const E2E_DIR = resolve(__dirname, "..")
export const LOCAL_DIR = resolve(E2E_DIR, ".local")
export const TLS_DIR = resolve(LOCAL_DIR, "tls")
export const FLEET_FILE = resolve(LOCAL_DIR, "fleet.json")
export const JKT1_USAGE_FILE = resolve(LOCAL_DIR, "jkt-1-node.json")
export const JKT2_USAGE_FILE = resolve(LOCAL_DIR, "jkt-2-node.json")
export const JKT2_BACKUPS_DIR = resolve(LOCAL_DIR, "jkt-2-backups")
export const AGENT_PORT = 19443
export const AGENT_ORIGIN = `https://127.0.0.1:${AGENT_PORT}`
export const AGENT_IMAGE = "hermes-e2e-agent:local"
export const DIND_CONTAINER = "hermes-e2e-jkt2-dind"
export const AGENT_CONTAINER = "hermes-e2e-jkt2-agent"
const DIND_RUN_VOL = "hermes-e2e-jkt2-run"
const DIND_DOCKER_VOL = "hermes-e2e-jkt2-docker"

function docker(args, opts = {}) {
  return (execFileSync("docker", args, { encoding: "utf8", ...opts }) ?? "").trim()
}

function findOpenssl() {
  for (const bin of ["openssl", "C:\\Program Files\\Git\\usr\\bin\\openssl.exe"]) {
    const res = spawnSync(bin, ["version"], { encoding: "utf8" })
    if (res.status === 0) return bin
  }
  return null
}

function runOpenssl(args, cwd) {
  const bin = findOpenssl()
  if (bin) {
    execFileSync(bin, args, { cwd, env: { ...process.env, MSYS_NO_PATHCONV: "1" }, stdio: "pipe" })
    return
  }
  execFileSync("docker", [
    "run", "--rm", "-v", `${cwd}:/tls`, "-w", "/tls",
    "--entrypoint", "openssl", "docker:27-dind", ...args,
  ], { stdio: "pipe" })
}

export function ensureFleetCerts() {
  const caDir = resolve(TLS_DIR, "ca")
  const serverDir = resolve(TLS_DIR, "jkt-2-server")
  const clientDir = resolve(TLS_DIR, "jkt-2-client")
  mkdirSync(caDir, { recursive: true })
  mkdirSync(serverDir, { recursive: true })
  mkdirSync(clientDir, { recursive: true })

  if (existsSync(resolve(serverDir, "tls.crt")) && existsSync(resolve(clientDir, "tls.crt"))) {
    return { caDir, serverDir, clientDir }
  }

  runOpenssl(["genrsa", "-out", "ca.key", "2048"], caDir)
  runOpenssl([
    "req", "-x509", "-new", "-nodes", "-key", "ca.key", "-sha256", "-days", "30",
    "-subj", "/CN=Hermes E2E Fleet CA", "-out", "ca.crt",
  ], caDir)

  writeFileSync(resolve(serverDir, "ext.cnf"), "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n", "utf8")
  runOpenssl(["genrsa", "-out", "tls.key", "2048"], serverDir)
  runOpenssl(["req", "-new", "-key", "tls.key", "-subj", "/CN=jkt-2", "-out", "tls.csr"], serverDir)
  runOpenssl([
    "x509", "-req", "-in", "tls.csr", "-CA", "../ca/ca.crt", "-CAkey", "../ca/ca.key",
    "-CAcreateserial", "-out", "tls.crt", "-days", "30", "-sha256", "-extfile", "ext.cnf",
  ], serverDir)

  writeFileSync(resolve(clientDir, "ext.cnf"), "extendedKeyUsage=clientAuth\n", "utf8")
  runOpenssl(["genrsa", "-out", "tls.key", "2048"], clientDir)
  runOpenssl(["req", "-new", "-key", "tls.key", "-subj", "/CN=jkt-1-control", "-out", "tls.csr"], clientDir)
  runOpenssl([
    "x509", "-req", "-in", "tls.csr", "-CA", "../ca/ca.crt", "-CAkey", "../ca/ca.key",
    "-CAcreateserial", "-out", "tls.crt", "-days", "30", "-sha256", "-extfile", "ext.cnf",
  ], clientDir)

  copyFileSync(resolve(caDir, "ca.crt"), resolve(serverDir, "ca.crt"))
  copyFileSync(resolve(caDir, "ca.crt"), resolve(clientDir, "ca.crt"))
  return { caDir, serverDir, clientDir }
}

export function writeHostUsageSnapshots(tenants = { jkt1: 0, jkt2: 0 }) {
  mkdirSync(LOCAL_DIR, { recursive: true })
  mkdirSync(JKT2_BACKUPS_DIR, { recursive: true })
  const ts = new Date().toISOString()
  const make = (count, memMb) => ({
    ts,
    cpus: 4,
    load1: 0.35,
    memTotalMb: 4096,
    memUsedMb: 1024 + memMb,
    memAvailableMb: 3072 - memMb,
    diskTotalMb: 32768,
    diskUsedMb: 6144,
    volumesTotalMb: 32768,
    volumesUsedMb: count * 64,
    tenants: count,
    tenantMemMb: memMb,
  })
  writeFileSync(JKT1_USAGE_FILE, JSON.stringify(make(tenants.jkt1, tenants.jkt1 * 128), null, 2), "utf8")
  writeFileSync(JKT2_USAGE_FILE, JSON.stringify(make(tenants.jkt2, tenants.jkt2 * 128), null, 2), "utf8")
}

export function writeFleetConfig() {
  const { clientDir } = ensureFleetCerts()
  writeHostUsageSnapshots()
  const config = {
    local: { name: "jkt-1", region: "jkt", cpuMillis: 4000, memoryMb: 4096, storageMb: 32768 },
    remote: [{
      name: "jkt-2",
      region: "jkt",
      cpuMillis: 4000,
      memoryMb: 4096,
      storageMb: 32768,
      origin: AGENT_ORIGIN,
      tlsDir: clientDir,
    }],
  }
  writeFileSync(FLEET_FILE, JSON.stringify(config, null, 2), "utf8")
  return config
}

function ensureAgentImage() {
  try {
    docker(["image", "inspect", AGENT_IMAGE], { stdio: ["pipe", "pipe", "ignore"] })
    return
  } catch {
    // build below
  }
  const imgDir = resolve(LOCAL_DIR, "agent-image")
  mkdirSync(imgDir, { recursive: true })
  writeFileSync(resolve(imgDir, "package.json"), JSON.stringify({
    name: "hermes-e2e-agent",
    private: true,
    type: "module",
    dependencies: {
      dockerode: "^5.0.1",
      dotenv: "^18.0.10",
      fastify: "5",
      pino: "^10.4.0",
      tsx: "^4.23.15",
      typescript: "^5.9.3",
      yaml: "2.9.1",
      zod: "^4.6.7",
    },
  }, null, 2), "utf8")
  writeFileSync(resolve(imgDir, "Dockerfile"), [
    "FROM node:22-bookworm-slim",
    "WORKDIR /app",
    "COPY package.json ./",
    "RUN npm install --omit=dev && npm cache clean --force",
    "",
  ].join("\n"), "utf8")
  execFileSync("docker", ["build", "-t", AGENT_IMAGE, "."], { cwd: imgDir, stdio: "inherit" })
}

function containerRunning(name) {
  try {
    return docker(["inspect", "-f", "{{.State.Running}}", name], { stdio: ["pipe", "pipe", "ignore"] }) === "true"
  } catch {
    return false
  }
}

function removeIfExists(name) {
  try {
    docker(["rm", "-f", name], { stdio: "ignore" })
  } catch {
    // ignore
  }
}

async function waitDindReady() {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    try {
      docker(["exec", DIND_CONTAINER, "docker", "-H", "unix:///var/run/docker.sock", "info"], { stdio: "ignore" })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error(`${DIND_CONTAINER} dockerd did not become ready`)
}

function ensureStubImageInDind() {
  const stubImage = process.env.HERMES_E2E_IMAGE ?? "hermes-stub:0.2.0"
  try {
    docker(["exec", DIND_CONTAINER, "docker", "-H", "unix:///var/run/docker.sock", "image", "inspect", stubImage], { stdio: ["pipe", "pipe", "ignore"] })
    return
  } catch {
    // stream image into dind
  }
  const saved = execFileSync("docker", ["save", stubImage], { maxBuffer: 256 * 1024 * 1024 })
  execFileSync("docker", ["exec", "-i", DIND_CONTAINER, "docker", "-H", "unix:///var/run/docker.sock", "load"], { input: saved, stdio: ["pipe", "inherit", "inherit"] })
}

async function waitAgentListening() {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (containerRunning(AGENT_CONTAINER)) {
      const logs = docker(["logs", AGENT_CONTAINER], { stdio: "pipe" })
      if (logs.includes("runtime agent ready")) return
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  const logs = (() => {
    try { return docker(["logs", AGENT_CONTAINER]) } catch { return "" }
  })()
  throw new Error(`${AGENT_CONTAINER} did not become ready. Logs:\n${logs}`)
}

export async function startLocalFleet() {
  const { serverDir, clientDir } = ensureFleetCerts()
  writeFleetConfig()
  ensureAgentImage()

  if (!containerRunning(DIND_CONTAINER)) {
    removeIfExists(AGENT_CONTAINER)
    removeIfExists(DIND_CONTAINER)
    docker([
      "run", "-d", "--name", DIND_CONTAINER,
      "--privileged",
      "-p", `127.0.0.1:${AGENT_PORT}:${AGENT_PORT}`,
      "-e", "DOCKER_TLS_CERTDIR=",
      "-v", `${DIND_RUN_VOL}:/hermes-sock`,
      "-v", `${DIND_DOCKER_VOL}:/var/lib/docker`,
      "docker:27-dind",
      "--tls=false",
      "-H", "unix:///var/run/docker.sock",
      "-H", "unix:///hermes-sock/docker.sock",
    ])
  }
  await waitDindReady()
  ensureStubImageInDind()

  if (!containerRunning(AGENT_CONTAINER)) {
    removeIfExists(AGENT_CONTAINER)
    const entryScript = [
      "IP=$(node -e \"const os=require('os');for(const l of Object.values(os.networkInterfaces()))for(const i of l)if(i.family==='IPv4'&&!i.internal){console.log(i.address);process.exit(0)}\")",
      "export HERMES_AGENT_BIND=\"$IP\"",
      "exec /app/node_modules/.bin/tsx src/runtime-agent.ts",
    ].join(" && ")
    docker([
      "run", "-d", "--name", AGENT_CONTAINER,
      "--network", `container:${DIND_CONTAINER}`,
      "-v", `${DIND_RUN_VOL}:/hermes-sock`,
      "-v", `${serverDir}:/tls:ro`,
      "-v", `${JKT2_USAGE_FILE}:/var/lib/hermes-usage/node.json:ro`,
      "-v", `${JKT2_BACKUPS_DIR}:/var/lib/hermes-backup-metadata:ro`,
      "-v", `${resolve(REPO_DIR, "src")}:/app/src:ro`,
      "-v", `${resolve(REPO_DIR, "tsconfig.json")}:/app/tsconfig.json:ro`,
      "-e", "NODE_ENV=development",
      "-e", "HERMES_AGENT_NAME=jkt-2",
      "-e", `HERMES_AGENT_PORT=${AGENT_PORT}`,
      "-e", "HERMES_AGENT_TLS_DIR=/tls",
      "-e", "DOCKER_SOCKET_PATH=/hermes-sock/docker.sock",
      "-e", "HERMES_AGENT_QUOTA_FILE=/tmp/quota-policy.json",
      "-e", "HERMES_RUNTIME=runc",
      "-e", "HERMES_DISK_QUOTA=off",
      "-e", "HERMES_EGRESS_POLICY=off",
      AGENT_IMAGE,
      "sh", "-c", entryScript,
    ])
  }
  await waitAgentListening()
  return {
    fleetFile: FLEET_FILE,
    jkt1UsageFile: JKT1_USAGE_FILE,
    jkt2UsageFile: JKT2_USAGE_FILE,
    agentOrigin: AGENT_ORIGIN,
    clientTlsDir: clientDir,
    serverTlsDir: serverDir,
    dindContainer: DIND_CONTAINER,
    agentContainer: AGENT_CONTAINER,
  }
}

export function stopLocalFleet() {
  removeIfExists(AGENT_CONTAINER)
  removeIfExists(DIND_CONTAINER)
}

async function main() {
  const cmd = process.argv[2] ?? "up"
  if (cmd === "up") {
    const info = await startLocalFleet()
    console.log(JSON.stringify(info, null, 2))
  } else if (cmd === "down") {
    stopLocalFleet()
    console.log("Stopped local E2E fleet (jkt-2 DinD + runtime-agent)")
  } else if (cmd === "status") {
    console.log(JSON.stringify({
      dind: containerRunning(DIND_CONTAINER),
      agent: containerRunning(AGENT_CONTAINER),
      fleetFile: existsSync(FLEET_FILE),
      agentOrigin: AGENT_ORIGIN,
    }, null, 2))
  } else {
    console.error(`Unknown command: ${cmd}. Use: up | down | status`)
    process.exit(1)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

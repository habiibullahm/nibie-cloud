import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { connect as tlsConnect } from "node:tls"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { inspectNodeDocker, loadRuntimeEnv, operatorApi, withPg } from "./helpers"

async function waitForStatus(env: ReturnType<typeof loadRuntimeEnv>, id: string, expected: string) {
  await expect.poll(async () => {
    const row = await withPg(env, async (pg) => {
      const res = await pg.query(
        `SELECT i.status, i."statusReason", i."tenantId", n.name AS node_name
         FROM "Instance" i JOIN "RuntimeNode" n ON n.id = i."nodeId"
         WHERE i.id = $1`,
        [id],
      )
      return res.rows[0] as { status: string; statusReason: string | null; tenantId: string; node_name: string }
    })
    if (row.status === "FAILED" && expected !== "DELETED") {
      throw new Error(`Instance ${id} reached FAILED: ${row.statusReason}`)
    }
    return row.status
  }, { timeout: 60_000, intervals: [500] }).toBe(expected)

  return withPg(env, async (pg) => {
    const res = await pg.query(
      `SELECT i.id, i.status, i."tenantId" AS tenant_id, n.name AS node_name
       FROM "Instance" i JOIN "RuntimeNode" n ON n.id = i."nodeId"
       WHERE i.id = $1`,
      [id],
    )
    return res.rows[0] as { id: string; status: string; tenant_id: string; node_name: string }
  })
}

async function waitNodeOnline(env: ReturnType<typeof loadRuntimeEnv>, nodeName: string, online: boolean) {
  await expect.poll(async () => {
    const res = await operatorApi(env, "/runtime-nodes")
    const body = await res.json() as { nodes: { name: string; online: boolean }[] }
    return body.nodes.find((n) => n.name === nodeName)?.online
  }, { timeout: 45_000, intervals: [1_000] }).toBe(online)
}

async function postUntrustedMtls(agentOrigin: string, ca: Buffer): Promise<void> {
  const url = new URL(`${agentOrigin}/v1/runtime`)
  await new Promise<void>((resolve, reject) => {
    const sock = tlsConnect({
      host: url.hostname,
      port: Number(url.port),
      ca,
      rejectUnauthorized: true,
    }, () => {
      sock.write(`POST /v1/runtime HTTP/1.1\r\nHost: ${url.host}\r\nContent-Length: 14\r\nContent-Type: application/json\r\n\r\n{"op":"ready"}`)
    })
    sock.setTimeout(3_000)
    sock.on("error", reject)
    sock.on("close", () => reject(new Error("TLS connection closed without response")))
    sock.on("data", (buf) => {
      resolve()
      sock.destroy()
      void buf
    })
  })
}

test("operator fleet placement, capacity full, cordon/uncordon, node outage, and cross-node recovery", async () => {
  const env = loadRuntimeEnv()
  const ca = readFileSync(join(env.clientTlsDir, "ca.crt"))
  await expect(postUntrustedMtls(env.agentOrigin, ca)).rejects.toThrow()

  const tenantIds: string[] = []
  let fullPlanId = ""
  const marker = `marker-${randomUUID()}`

  try {
    expect((await operatorApi(env, "/runtime-nodes/jkt-2/schedulable", { schedulable: true })).status).toBe(200)
    await waitNodeOnline(env, "jkt-2", true)

    await withPg(env, async (pg) => {
      for (let i = 0; i < 3; i++) {
        const id = randomUUID()
        await pg.query(`INSERT INTO "Tenant" (id, name) VALUES ($1, $2)`, [id, `E2E Fleet ${i}`])
        tenantIds.push(id)
      }
      fullPlanId = randomUUID()
      await pg.query(
        `INSERT INTO "Plan" (id, slug, name, "cpuMillis", "memoryMb", "storageMb", pids)
         VALUES ($1, $2, 'Fleet Drill', 4000, 4096, 1024, 128)`,
        [fullPlanId, `fleet-drill-${randomUUID()}`],
      )
    })

    // Parallel placement across jkt-1 and jkt-2
    const created = await Promise.all(tenantIds.slice(0, 2).map(async (tenantId) => {
      const res = await operatorApi(env, `/tenants/${tenantId}/instances`, { name: "Fleet Drill", planId: fullPlanId }, "fleet-drill")
      expect(res.status, await res.clone().text()).toBe(202)
      const body = await res.json() as { instance: { id: string } }
      return waitForStatus(env, body.instance.id, "ACTIVE")
    }))

    const remote = created.find((r) => r.node_name === "jkt-2")
    const local = created.find((r) => r.node_name === "jkt-1")
    expect(remote).toBeTruthy()
    expect(local).toBeTruthy()
    expect(inspectNodeDocker(env, "jkt-2", remote!.id)).toEqual({ state: "running", volumePresent: true })
    expect(inspectNodeDocker(env, "jkt-1", local!.id)).toEqual({ state: "running", volumePresent: true })
    expect(inspectNodeDocker(env, "jkt-2", local!.id)).toEqual({ state: "absent", volumePresent: false })

    // Capacity full -> 409
    const overflow = await operatorApi(env, `/tenants/${tenantIds[2]}/instances`, { name: "Overflow", planId: fullPlanId }, "overflow")
    expect(overflow.status).toBe(409)

    // Idempotency replay -> 202 with same ID
    const replayRes = await operatorApi(env, `/tenants/${remote!.tenant_id}/instances`, { name: "Fleet Drill", planId: fullPlanId }, "fleet-drill")
    expect(replayRes.status).toBe(202)
    const replayBody = await replayRes.json() as { instance: { id: string } }
    expect(replayBody.instance.id).toBe(remote!.id)

    // Remote lifecycle on jkt-2
    const remoteBase = `/tenants/${remote!.tenant_id}/instances/${remote!.id}`
    expect((await operatorApi(env, `${remoteBase}/stop`, {})).status).toBe(202)
    await waitForStatus(env, remote!.id, "STOPPED")
    expect(inspectNodeDocker(env, "jkt-2", remote!.id).state).toBe("exited")

    expect((await operatorApi(env, `${remoteBase}/start`, {})).status).toBe(202)
    await waitForStatus(env, remote!.id, "ACTIVE")
    expect(inspectNodeDocker(env, "jkt-2", remote!.id).state).toBe("running")

    expect((await operatorApi(env, `${remoteBase}/restart`, {})).status).toBe(202)
    await waitForStatus(env, remote!.id, "ACTIVE")

    // Cordon jkt-2, delete remote instance, confirm blocked capacity
    expect((await operatorApi(env, "/runtime-nodes/jkt-2/schedulable", { schedulable: false })).status).toBe(200)
    expect((await operatorApi(env, remoteBase, undefined, undefined, "DELETE")).status).toBe(202)
    await waitForStatus(env, remote!.id, "DELETED")
    expect(inspectNodeDocker(env, "jkt-2", remote!.id)).toEqual({ state: "absent", volumePresent: false })
    expect((await operatorApi(env, `/tenants/${tenantIds[2]}/instances`, { name: "Overflow", planId: fullPlanId }, "overflow-cordon")).status).toBe(409)

    // Node outage drill: uncordon jkt-2, stop agent container, verify offline + local lifecycle still works
    expect((await operatorApi(env, "/runtime-nodes/jkt-2/schedulable", { schedulable: true })).status).toBe(200)
    try {
      execFileSync("docker", ["stop", env.agentContainer], { stdio: "ignore" })
      await waitNodeOnline(env, "jkt-2", false)
      expect((await operatorApi(env, `/tenants/${tenantIds[2]}/instances`, { name: "Overflow", planId: fullPlanId }, "overflow-outage")).status).toBe(409)

      const localBase = `/tenants/${local!.tenant_id}/instances/${local!.id}`
      expect((await operatorApi(env, `${localBase}/stop`, {})).status).toBe(202)
      await waitForStatus(env, local!.id, "STOPPED")
      expect((await operatorApi(env, `${localBase}/start`, {})).status).toBe(202)
      await waitForStatus(env, local!.id, "ACTIVE")
    } finally {
      execFileSync("docker", ["start", env.agentContainer], { stdio: "ignore" })
      await waitNodeOnline(env, "jkt-2", true)
    }

    // Cross-node recovery: jkt-1 -> jkt-2
    const localBase = `/tenants/${local!.tenant_id}/instances/${local!.id}`
    execFileSync("docker", [
      "run", "--rm", "--entrypoint", "sh",
      "-v", `hermes-data-${local!.id}:/opt/data`,
      env.hermesImage, "-c", `printf '%s' '${marker}' > /opt/data/recovery-marker.txt && chown 10000:10000 /opt/data/recovery-marker.txt`,
    ])

    expect((await operatorApi(env, `${localBase}/stop`, {})).status).toBe(202)
    await waitForStatus(env, local!.id, "STOPPED")

    const prepRes = await operatorApi(env, `${localBase}/recovery/prepare`, { node: "jkt-2" })
    expect(prepRes.status, await prepRes.clone().text()).toBe(200)
    expect((await operatorApi(env, `${localBase}/start`, {})).status).toBe(409)

    const tarBuf = execFileSync("docker", [
      "run", "--rm", "--entrypoint", "sh",
      "-v", `hermes-data-${local!.id}:/opt/data:ro`,
      env.hermesImage, "-c", "tar cf - -C /opt/data .",
    ])
    execFileSync("docker", [
      "exec", "-i", env.dindContainer,
      "docker", "-H", "unix:///var/run/docker.sock", "run", "--rm", "-i", "--entrypoint", "sh",
      "-v", `hermes-data-${local!.id}:/opt/data`,
      env.hermesImage, "-c", "tar xf - -C /opt/data",
    ], { input: tarBuf })

    const restoredMarker = execFileSync("docker", [
      "exec", env.dindContainer,
      "docker", "-H", "unix:///var/run/docker.sock", "run", "--rm", "--entrypoint", "sh",
      "-v", `hermes-data-${local!.id}:/opt/data:ro`,
      env.hermesImage, "-c", "cat /opt/data/recovery-marker.txt",
    ], { encoding: "utf8" }).trim()
    expect(restoredMarker).toBe(marker)

    expect((await operatorApi(env, `${localBase}/recovery/finish`, { restoreVerified: true })).status).toBe(200)
    expect((await operatorApi(env, `${localBase}/start`, {})).status).toBe(202)
    const recovered = await waitForStatus(env, local!.id, "ACTIVE")
    expect(recovered.node_name).toBe("jkt-2")
    expect(inspectNodeDocker(env, "jkt-2", local!.id).state).toBe("running")

    expect((await operatorApi(env, `${localBase}/recovery/retire`, { node: "jkt-1", discardSource: true })).status).toBe(200)
    expect(inspectNodeDocker(env, "jkt-1", local!.id)).toEqual({ state: "absent", volumePresent: false })
    expect(inspectNodeDocker(env, "jkt-2", local!.id).state).toBe("running")
  } finally {
    const rows = await withPg(env, async (pg) => {
      if (tenantIds.length === 0) return []
      const res = await pg.query(
        `SELECT id, "tenantId" AS tenant_id FROM "Instance" WHERE "tenantId" = ANY($1::uuid[]) AND status IN ('ACTIVE', 'DEGRADED', 'STOPPED', 'FAILED')`,
        [tenantIds],
      )
      return res.rows as { id: string; tenant_id: string }[]
    })
    for (const r of rows) {
      await operatorApi(env, `/tenants/${r.tenant_id}/instances/${r.id}`, undefined, undefined, "DELETE").catch(() => undefined)
      await waitForStatus(env, r.id, "DELETED").catch(() => undefined)
    }
    if (fullPlanId) {
      await withPg(env, async (pg) => {
        await pg.query(`DELETE FROM "InstanceEvent" WHERE "instanceId" IN (SELECT id FROM "Instance" WHERE "tenantId" = ANY($1::uuid[]))`, [tenantIds])
        await pg.query(`DELETE FROM "Instance" WHERE "tenantId" = ANY($1::uuid[])`, [tenantIds])
        await pg.query(`DELETE FROM "Tenant" WHERE id = ANY($1::uuid[])`, [tenantIds])
        await pg.query(`DELETE FROM "Plan" WHERE id = $1`, [fullPlanId])
      }).catch(() => undefined)
    }
  }
})

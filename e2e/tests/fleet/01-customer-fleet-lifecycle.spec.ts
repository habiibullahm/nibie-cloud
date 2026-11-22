import { expect, test } from "@playwright/test"
import { inspectNodeDocker, loadRuntimeEnv, operatorApi, signInUi, withPg } from "./helpers"

test("customer signs in, deploys an instance onto a real fleet node, and exercises full lifecycle", async ({ page }) => {
  const env = loadRuntimeEnv()
  const instanceName = `fleet-ui-${Date.now().toString(36)}`
  await signInUi(page, env.customerEmail, env.customerPassword)

  await page.goto("/dashboard/deploy")
  await page.locator("#instance-name").fill(instanceName)
  await page.locator('button[type="submit"]').click()

  await page.waitForURL(/\/dashboard\/instances\/[0-9a-f-]+/)
  const instanceId = page.url().match(/\/instances\/([0-9a-f-]+)/)?.[1]
  expect(instanceId).toBeTruthy()

  try {
    await expect(page.locator('[data-tone="ok"]').filter({ hasText: /^(Active|Aktif)$/ })).toBeVisible({ timeout: 60_000 })

    const row = await withPg(env, async (pg) => {
      const res = await pg.query(
        `SELECT i.status, i."tenantId" AS tenant_id, n.name AS node_name
         FROM "Instance" i
         JOIN "RuntimeNode" n ON n.id = i."nodeId"
         WHERE i.id = $1`,
        [instanceId],
      )
      return res.rows[0] as { status: string; tenant_id: string; node_name: string }
    })
    expect(row.status).toBe("ACTIVE")
    expect(["jkt-1", "jkt-2"]).toContain(row.node_name)

    const otherNode = row.node_name === "jkt-1" ? "jkt-2" : "jkt-1"
    expect(inspectNodeDocker(env, row.node_name, instanceId!)).toEqual({ state: "running", volumePresent: true })
    expect(inspectNodeDocker(env, otherNode, instanceId!)).toEqual({ state: "absent", volumePresent: false })

    // Stop (queued jobs return pre-transition status; wait on DB then reload UI once)
    await page.getByRole("button", { name: /^(Stop|Hentikan)$/ }).click()
    await page.getByRole("button", { name: /^(Stop instance|Hentikan instance)$/ }).click()
    await expect.poll(async () => {
      return withPg(env, async (pg) => {
        const res = await pg.query(`SELECT status FROM "Instance" WHERE id = $1`, [instanceId])
        return res.rows[0]?.status
      })
    }, { timeout: 45_000, intervals: [500] }).toBe("STOPPED")
    await page.reload()
    await expect(page.locator('[data-tone="neutral"]').filter({ hasText: /^(Stopped|Berhenti)$/ })).toBeVisible()
    expect(inspectNodeDocker(env, row.node_name, instanceId!).state).toBe("exited")

    // Start
    await page.getByRole("button", { name: /^(Start|Jalankan)$/ }).click()
    await expect.poll(async () => {
      return withPg(env, async (pg) => {
        const res = await pg.query(`SELECT status FROM "Instance" WHERE id = $1`, [instanceId])
        return res.rows[0]?.status
      })
    }, { timeout: 45_000, intervals: [500] }).toBe("ACTIVE")
    await page.reload()
    await expect(page.locator('[data-tone="ok"]').filter({ hasText: /^(Active|Aktif)$/ })).toBeVisible()
    expect(inspectNodeDocker(env, row.node_name, instanceId!).state).toBe("running")

    // Restart
    await page.getByRole("button", { name: /^(Restart|Mulai ulang)$/ }).click()
    await page.getByRole("alertdialog").getByRole("button", { name: /^(Restart|Mulai ulang)$/ }).click()
    await expect.poll(async () => {
      return withPg(env, async (pg) => {
        const res = await pg.query(
          `SELECT count(*)::int AS c FROM "InstanceEvent" WHERE "instanceId" = $1 AND type = 'runtime.restart'`,
          [instanceId],
        )
        return res.rows[0].c as number
      })
    }, { timeout: 45_000, intervals: [500] }).toBeGreaterThan(0)
    await expect.poll(async () => {
      return withPg(env, async (pg) => {
        const res = await pg.query(`SELECT status FROM "Instance" WHERE id = $1`, [instanceId])
        return res.rows[0]?.status
      })
    }, { timeout: 45_000, intervals: [500] }).toBe("ACTIVE")
    await page.reload()
    await expect(page.locator('[data-tone="ok"]').filter({ hasText: /^(Active|Aktif)$/ })).toBeVisible()

    // Delete
    await page.getByRole("button", { name: /^(Delete|Hapus)/ }).click()
    await page.locator("#confirm-name").fill(instanceName)
    await page.getByRole("button", { name: /^(Delete instance|Hapus instance)$/ }).click()
    await page.waitForURL(/\/dashboard\/instances$/)

    await expect.poll(async () => {
      return withPg(env, async (pg) => {
        const res = await pg.query(`SELECT status FROM "Instance" WHERE id = $1`, [instanceId])
        return res.rows[0]?.status
      })
    }, { timeout: 45_000, intervals: [500] }).toBe("DELETED")
    expect(inspectNodeDocker(env, row.node_name, instanceId!)).toEqual({ state: "absent", volumePresent: false })
  } finally {
    if (instanceId) {
      const leftover = await withPg(env, async (pg) => {
        const res = await pg.query(`SELECT status, "tenantId" AS tenant_id FROM "Instance" WHERE id = $1`, [instanceId])
        return res.rows[0] as { status: string; tenant_id: string } | undefined
      }).catch(() => undefined)
      if (leftover && leftover.status !== "DELETED") {
        await operatorApi(env, `/tenants/${leftover.tenant_id}/instances/${instanceId}`, undefined, undefined, "DELETE").catch(() => undefined)
        await expect.poll(async () => {
          return withPg(env, async (pg) => {
            const res = await pg.query(`SELECT status FROM "Instance" WHERE id = $1`, [instanceId])
            return res.rows[0]?.status
          })
        }, { timeout: 45_000, intervals: [500] }).toBe("DELETED").catch(() => undefined)
      }
    }
  }
})

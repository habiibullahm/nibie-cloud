import { expect, test } from "@playwright/test"
import { loadRuntimeEnv, operatorApi, signInUi, totpCode, withPg, writeFreshHostUsage } from "./helpers"

test("admin enrolls TOTP for aal2 and sees jkt-1 and jkt-2 capacity cards and status on /admin/node", async ({ page }) => {
  const env = loadRuntimeEnv()
  writeFreshHostUsage(env, { jkt1: 0, jkt2: 0 })

  const schedRes = await operatorApi(env, "/runtime-nodes/jkt-2/schedulable", { schedulable: true })
  expect(schedRes.status).toBe(200)

  await signInUi(page, env.adminEmail, env.adminPassword)
  await page.goto("/dashboard/admin/node")

  await expect(page.getByRole("heading", { level: 1, name: "Verifikasi dua langkah" })).toBeVisible()
  const secret = await page.locator("#mfa-secret").inputValue()
  expect(secret.length).toBeGreaterThan(8)

  const code = totpCode(secret)
  await page.locator("#mfa-code").fill(code)
  await page.getByRole("button", { name: "Verifikasi" }).click()

  await expect(page.getByRole("heading", { level: 1, name: "Node" })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText("Kapasitas jkt-1")).toBeVisible()
  await expect(page.getByText("Kapasitas jkt-2")).toBeVisible()

  const table = page.getByRole("table")
  const jkt1Row = table.getByRole("row", { name: /jkt-1/ })
  const jkt2Row = table.getByRole("row", { name: /jkt-2/ })
  await expect(jkt1Row).toContainText("Terhubung")
  await expect(jkt1Row).toContainText("Ya")
  await expect(jkt2Row).toContainText("Terhubung")
  await expect(jkt2Row).toContainText("Ya")

  const audited = await withPg(env, async (pg) => {
    const res = await pg.query(
      `SELECT count(*)::int AS c FROM "AuditLog" WHERE "actorEmail" = $1 AND action = 'GET /api/v1/admin/nodes'`,
      [env.adminEmail],
    )
    return res.rows[0].c as number
  })
  expect(audited).toBeGreaterThan(0)
})

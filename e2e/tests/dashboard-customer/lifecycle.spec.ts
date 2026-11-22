import { expect, test } from "@playwright/test"
import { containerState, deleteAllInstances, volumeExists } from "../../support/backend"
import { authFile, emailOf, required, USER_PASSWORD_VAR } from "../../support/env"
import { signInToken } from "../../support/supabase-admin"
import { status } from "../dashboard-mock/helpers"

test.use({ storageState: authFile("lifecycle") })
test.describe.configure({ mode: "serial" })

const NAME = "e2e-lifecycle"
let instanceId = ""

test.beforeAll(async () => {
  await deleteAllInstances(await signInToken(emailOf("lifecycle"), required(USER_PASSWORD_VAR)))
})
// Leaves nothing behind even when a test failed half way (the backend allows one instance per tenant).
test.afterAll(async () => {
  await deleteAllInstances(await signInToken(emailOf("lifecycle"), required(USER_PASSWORD_VAR)))
})

const ACTIVE = { timeout: 120_000 }

test("deploy creates a real container and the instance becomes Active", async ({ page }) => {
  await page.goto("/dashboard/deploy")
  await page.getByLabel("Instance name").fill(NAME)
  await page.getByRole("button", { name: "Deploy instance" }).click()
  await page.getByRole("alertdialog", { name: "Deploy instance?" }).getByRole("button", { name: "Deploy instance" }).click()
  await page.waitForURL(/\/instances\/[0-9a-f-]{36}$/)
  instanceId = page.url().split("/").pop()!
  await expect(status(page, "Active")).toBeVisible(ACTIVE)
  expect(containerState(instanceId)).toBe("running")
  expect(volumeExists(instanceId)).toBe(true)
})

test("stop stops the container and keeps the data volume", async ({ page }) => {
  await page.goto(`/dashboard/instances/${instanceId}`)
  await page.getByRole("button", { name: "Stop", exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Stop instance" }).click()
  await expect(status(page, "Stopped")).toBeVisible(ACTIVE)
  expect(containerState(instanceId)).not.toBe("running")
  expect(volumeExists(instanceId)).toBe(true)
})

test("start brings it back", async ({ page }) => {
  await page.goto(`/dashboard/instances/${instanceId}`)
  await page.getByRole("button", { name: "Start", exact: true }).click()
  await page.getByRole("alertdialog", { name: "Start instance?" }).getByRole("button", { name: "Start", exact: true }).click()
  await expect(status(page, "Active")).toBeVisible(ACTIVE)
  expect(containerState(instanceId)).toBe("running")
})

test("restart returns to Active", async ({ page }) => {
  await page.goto(`/dashboard/instances/${instanceId}`)
  await page.getByRole("button", { name: "Restart", exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Restart", exact: true }).click()
  await expect(status(page, "Active")).toBeVisible(ACTIVE)
  expect(containerState(instanceId)).toBe("running")
})

test("delete removes the container and the volume", async ({ page }) => {
  await page.goto(`/dashboard/instances/${instanceId}`)
  await page.getByRole("button", { name: `Delete ${NAME}` }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel(/Type .* to confirm/).fill(NAME)
  await dialog.getByRole("button", { name: "Delete", exact: false }).last().click()
  await expect(page).toHaveURL(/\/dashboard\/instances$/, { timeout: 60_000 })
  await expect.poll(() => containerState(instanceId), { timeout: 60_000 }).toBe("absent")
  await expect.poll(() => volumeExists(instanceId), { timeout: 60_000 }).toBe(false)
})

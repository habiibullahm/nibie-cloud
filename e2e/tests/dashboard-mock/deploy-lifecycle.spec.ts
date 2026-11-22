import { expect, test } from "@playwright/test"
import { BASE, deployInstance, status, waitActive } from "./helpers"

test("the deploy form refuses an empty name and says why", async ({ page }) => {
  await page.goto(`${BASE}/deploy`)
  await page.getByRole("button", { name: "Deploy instance" }).click()
  await expect(page.getByText("Enter a name for your instance.")).toBeVisible()
  await expect(page).toHaveURL(/\/deploy$/)
})

test("deploy: queued, then progress, then Active with the actions available", async ({ page }) => {
  await deployInstance(page, "e2e-deploy")
  await expect(page.getByRole("heading", { name: "e2e-deploy" })).toBeVisible()
  await expect(page.getByRole("list", { name: "Deployment progress" })).toBeVisible()
  await waitActive(page)
  await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Start", exact: true })).toHaveCount(0)
})

test("stop asks for confirmation, then start brings it back", async ({ page }) => {
  await deployInstance(page, "e2e-stop")
  await waitActive(page)

  await page.getByRole("button", { name: "Stop", exact: true }).click()
  const dialog = page.getByRole("alertdialog")
  await expect(dialog).toContainText("Stop instance?")
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(status(page, "Active")).toBeVisible()

  await page.getByRole("button", { name: "Stop", exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Stop instance" }).click()
  await expect(status(page, "Stopped")).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)

  await page.getByRole("button", { name: "Start", exact: true }).click()
  await page.getByRole("alertdialog", { name: "Start instance?" }).getByRole("button", { name: "Start", exact: true }).click()
  await waitActive(page)
})

test("restart asks for confirmation and returns to Active", async ({ page }) => {
  await deployInstance(page, "e2e-restart")
  await waitActive(page)
  await page.getByRole("button", { name: "Restart", exact: true }).click()
  await expect(page.getByRole("alertdialog")).toContainText("Restart instance?")
  await page.getByRole("alertdialog").getByRole("button", { name: "Restart", exact: true }).click()
  await waitActive(page)
})

test("delete needs the exact name, then removes the instance from the list", async ({ page }) => {
  await deployInstance(page, "e2e-delete")
  await waitActive(page)

  await page.getByRole("button", { name: "Delete e2e-delete" }).click()
  const dialog = page.getByRole("dialog")
  const confirm = dialog.getByRole("button", { name: "Delete", exact: false }).last()
  await expect(dialog).toContainText("Delete instance?")
  await dialog.getByLabel(/Type .* to confirm/).fill("e2e-wrong")
  await expect(confirm).toBeDisabled()
  await dialog.getByLabel(/Type .* to confirm/).fill("e2e-delete")
  await expect(confirm).toBeEnabled()
  await confirm.click()

  await expect(page).toHaveURL(/\/dashboard\/instances$/, { timeout: 20_000 })
  await expect(page.getByRole("list", { name: "Your instances" }).getByText("e2e-delete")).toHaveCount(0, { timeout: 20_000 })
})

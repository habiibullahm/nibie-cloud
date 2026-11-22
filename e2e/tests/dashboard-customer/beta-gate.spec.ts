import { expect, test } from "@playwright/test"
import { listInstances } from "../../support/backend"
import { authFile, emailOf, required, USER_PASSWORD_VAR } from "../../support/env"
import { signInToken } from "../../support/supabase-admin"

test.use({ storageState: authFile("outsider") })

test("a user outside the beta list is refused with a clear message and gets no container", async ({ page }) => {
  await page.goto("/dashboard/deploy")
  await page.getByLabel("Instance name").fill("e2e-outsider")
  await page.getByRole("button", { name: "Deploy instance" }).click()
  await page.getByRole("alertdialog", { name: "Deploy instance?" }).getByRole("button", { name: "Deploy instance" }).click()
  const alert = page.getByRole("alert").filter({ hasText: "Deployment failed" })
  await expect(alert).toContainText("not enabled for this account")
  const token = await signInToken(emailOf("outsider"), required(USER_PASSWORD_VAR))
  expect(await listInstances(token)).toEqual([])
})

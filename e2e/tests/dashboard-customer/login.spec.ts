import { expect, test } from "@playwright/test"
import { emailOf, required, USER_PASSWORD_VAR } from "../../support/env"

test.use({ storageState: { cookies: [], origins: [] } })

test("without a session the dashboard sends the visitor to sign-in", async ({ page }) => {
  await page.goto("/dashboard/instances")
  await expect(page).toHaveURL(/\/dashboard\/sign-in$/)
})

test("a wrong password shows an error and stays on sign-in", async ({ page }) => {
  await page.goto("/dashboard/sign-in")
  await page.getByLabel("Email").fill(emailOf("login"))
  await page.getByLabel("Password").fill(`${required(USER_PASSWORD_VAR)}-wrong`)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByText("Email or password is not correct.")).toBeVisible()
  await expect(page).toHaveURL(/\/dashboard\/sign-in$/)
})

test("sign in, see the empty list, sign out", async ({ page }) => {
  await page.goto("/dashboard/sign-in")
  await page.getByLabel("Email").fill(emailOf("login"))
  await page.getByLabel("Password").fill(required(USER_PASSWORD_VAR))
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL(/\/dashboard\/instances$/)
  await expect(page.getByText("No instances yet")).toBeVisible()
  await page.getByRole("button", { name: "Sign out" }).click()
  await expect(page).toHaveURL(/\/dashboard\/sign-in$/)
  await page.goto("/dashboard/instances")
  await expect(page).toHaveURL(/\/dashboard\/sign-in$/)
})

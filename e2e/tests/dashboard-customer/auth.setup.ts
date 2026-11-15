import { expect, test } from "@playwright/test"
import { authFile, emailOf, required, USER_PASSWORD_VAR, type UserKey } from "../../support/env"
import { canManageUsers, recreateUser } from "../../support/supabase-admin"

// Creates the test users through the Supabase Admin API when the secret key is set (a dedicated test project), or
// uses users that already exist (the shared project, no secret key anywhere), signs each in through the real login
// form once and saves the session. This project runs with trace, video and screenshots off because it types a password.
const USERS: UserKey[] = ["lifecycle", "outsider"]

for (const key of USERS) {
  test(`create and sign in ${key}`, async ({ browser }) => {
    const password = required(USER_PASSWORD_VAR)
    if (canManageUsers()) await recreateUser(emailOf(key), password)
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto("/dashboard/sign-in")
    await page.getByLabel("Email").fill(emailOf(key))
    await page.getByLabel("Password").fill(password)
    await page.getByRole("button", { name: "Sign in" }).click()
    await expect(page).toHaveURL(/\/dashboard\/instances$/)
    await context.storageState({ path: authFile(key) })
    await context.close()
  })
}

// The `login` user has no saved session: its spec signs in itself.
test("create the login user", async () => {
  if (canManageUsers()) await recreateUser(emailOf("login"), required(USER_PASSWORD_VAR))
})

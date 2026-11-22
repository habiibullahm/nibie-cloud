import { expect, type Locator, type Page } from "@playwright/test"

export const BASE = "/dashboard"

/** The status badge on an instance page or card. Its text is the label from `presentStatus`. */
export function status(scope: Page | Locator, label: string): Locator {
  return scope.locator("[data-tone]").filter({ hasText: new RegExp(`^${label}$`, "i") })
}

/** Deploys a new mock instance and waits until the page for it is open. */
export async function deployInstance(page: Page, name: string): Promise<string> {
  await page.goto(`${BASE}/deploy`)
  await page.getByLabel("Instance name").fill(name)
  await page.getByRole("button", { name: "Deploy instance" }).click()
  await page.getByRole("alertdialog", { name: "Deploy instance?" }).getByRole("button", { name: "Deploy instance" }).click()
  await page.waitForURL(/\/instances\/[0-9a-f-]{36}$/)
  return page.url()
}

/** Mock transitions take a few seconds in real time (STEP_MS = 1500 in apps/web mock.ts). */
export async function waitActive(page: Page): Promise<void> {
  await expect(status(page, "Active")).toBeVisible({ timeout: 20_000 })
}

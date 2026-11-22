import { expect, test } from "@playwright/test"
import { expectNoSeriousViolations } from "../../support/a11y"
import { BASE } from "./helpers"

const KNOWN: Record<string, Record<string, string>> = {
  "/sign-in": { "link-in-text-block": "'Create an account' differs from the text only by color (2.31:1, needs 3:1) or an underline." },
}

for (const path of ["/sign-in", "/instances", "/deploy"]) {
  test(`${path} has no new serious accessibility violations`, async ({ page }) => {
    await page.goto(`${BASE}${path}`)
    await expectNoSeriousViolations(page, KNOWN[path])
  })
}

async function openInstanceAndStopDialog(page: import("@playwright/test").Page) {
  await page.goto(`${BASE}/instances`)
  await page.getByRole("listitem").filter({ hasText: "atlas-assistant" }).getByRole("link", { name: "atlas-assistant" }).click()
  const stop = page.getByRole("button", { name: "Stop", exact: true })
  await stop.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("alertdialog")).toBeVisible()
  return stop
}

test("the Stop dialog opens from the keyboard and Escape closes it", async ({ page }) => {
  await openInstanceAndStopDialog(page)
  await page.keyboard.press("Escape")
  await expect(page.getByRole("alertdialog")).toHaveCount(0)
})

test("focus returns to the Stop button after the dialog closes", async ({ page }) => {
  const stop = await openInstanceAndStopDialog(page)
  await page.keyboard.press("Escape")
  await expect(stop).toBeFocused()
})

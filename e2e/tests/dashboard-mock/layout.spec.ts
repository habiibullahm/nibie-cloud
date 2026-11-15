import { expect, test } from "@playwright/test"
import { BASE } from "./helpers"

// Runs on desktop (`dashboard-mock`) and on a phone (`dashboard-mock-mobile`).
for (const path of ["/sign-in", "/instances", "/deploy"]) {
  test(`${path} has no horizontal overflow and no console errors`, async ({ page }) => {
    const errors: string[] = []
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
    page.on("pageerror", (e) => errors.push(e.message))
    await page.goto(`${BASE}${path}`)
    await page.waitForLoadState("networkidle")
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    expect(errors).toEqual([])
  })
}

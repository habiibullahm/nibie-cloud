import { test } from "@playwright/test"
import { expectNoSeriousViolations } from "../../support/a11y"

// DESIGN.md requires WCAG AA. Findings that were reported and not fixed yet are listed with their reason.
const KNOWN: Record<string, Record<string, string>> = {
  "/": { "definition-list": "Hero <dl> has a role=img child (aside > .p-4); a <dl> may only contain dt/dd/div." },
}

for (const path of ["/", "/harga", "/kontak", "/kebijakan-privasi"]) {
  test(`${path} has no new serious accessibility violations`, async ({ page }) => {
    await page.goto(path)
    await expectNoSeriousViolations(page, KNOWN[path])
  })
}

import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"

/**
 * Fails on serious or critical WCAG A/AA violations (DESIGN.md requires AA), except the rule ids in `known`.
 * Known items are findings that were reported and not fixed yet; each is listed as an annotation in the report.
 * When a known item stops being reported, the test fails so the entry gets removed.
 */
export async function expectNoSeriousViolations(page: Page, known: Record<string, string> = {}): Promise<void> {
  // Entrance animations make axe measure half-transparent text; the real contrast is checked with motion off.
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.waitForLoadState("networkidle")
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()
  const serious = violations.filter((v) => v.impact === "serious" || v.impact === "critical")
  const describe = (v: (typeof serious)[number]) => `${v.id}: ${v.nodes.length} node(s), e.g. ${v.nodes[0]?.target.join(" ")}`
  for (const v of serious) {
    if (known[v.id]) test.info().annotations.push({ type: "known-a11y-issue", description: `${describe(v)}. ${known[v.id]}` })
  }
  expect(serious.filter((v) => !known[v.id]).map(describe)).toEqual([])
  const gone = Object.keys(known).filter((id) => !serious.some((v) => v.id === id))
  expect(gone, "known issue no longer reported: remove it from the list").toEqual([])
}

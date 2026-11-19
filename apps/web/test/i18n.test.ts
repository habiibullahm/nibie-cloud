import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ID } from "../src/lib/i18n-id"
import { translate } from "../src/lib/i18n"
import { presentStatus } from "../src/lib/api/status"
import type { BillingStatus, InstanceStatus } from "../src/lib/api/types"
import { billingStatusLabel } from "../src/lib/billing"
import { GROUPS, SORTS } from "../src/lib/instance-list"
import { validateInstanceName } from "../src/app/(app)/deploy/validate-name"
import { instanceStatusId } from "../src/lib/admin-format"
import { CATEGORY, CUSTOMER_STATUS } from "../src/lib/ticket-labels"

function literals(dir: string, out = new Set<string>()): Set<string> {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) literals(p, out)
    else if (/\.tsx?$/.test(f)) for (const m of readFileSync(p, "utf8").matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) out.add(m[1]!)
  }
  return out
}
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe("Bahasa Indonesia dictionary", () => {
  it("has an entry for every t(\"...\") literal in the source", () => {
    const missing = [...literals(join(__dirname, "../src"))].filter((s) => !(s in ID))
    expect(missing).toEqual([])
  })

  it("covers texts translated at runtime (status, groups, sorts, billing status, name errors)", () => {
    const statuses: InstanceStatus[] = ["PENDING", "PROVISIONING", "CONFIGURING", "STARTING", "ACTIVE", "DEGRADED", "STOPPING", "STOPPED", "SUSPENDED", "FAILED", "DELETING", "DELETED"]
    const billing: BillingStatus[] = ["PENDING_PAYMENT", "ACTIVE", "GRACE", "SUSPENDED", "ENDED"]
    const texts = [
      ...statuses.flatMap((s) => {
        const p = presentStatus(s)
        return [p.label, p.defaultReason, p.nextAction]
      }),
      ...GROUPS.map((g) => g.label),
      ...SORTS.map((s) => s.label),
      ...Object.values(CUSTOMER_STATUS),
      ...Object.values(CATEGORY),
      ...billing.map((b) => billingStatusLabel(b, false)),
      billingStatusLabel("ACTIVE", true),
      validateInstanceName(""),
      validateInstanceName("x".repeat(64)),
      validateInstanceName("a\u0007b"),
    ].filter((s): s is string => typeof s === "string")
    expect(texts.filter((s) => !(s in ID))).toEqual([])
  })

  it("keeps the same placeholders in every translation", () => {
    const bad = Object.entries(ID).filter(([en, id]) => placeholders(en).join() !== placeholders(id).join())
    expect(bad).toEqual([])
  })
})

describe("status words", () => {
  it("are the same in the customer dashboard and the admin panel", () => {
    // CONFIGURING is shown to customers as Provisioning, so the admin's own word for it is not compared.
    const statuses: InstanceStatus[] = ["PENDING", "PROVISIONING", "STARTING", "ACTIVE", "DEGRADED", "STOPPING", "STOPPED", "SUSPENDED", "FAILED", "DELETING", "DELETED"]
    const differ = statuses.filter((s) => translate("id", presentStatus(s).label) !== instanceStatusId(s))
    expect(differ).toEqual([])
  })
})

describe("translate", () => {
  it("translates, fills placeholders and falls back to English", () => {
    expect(translate("id", "Open {name}", { name: "aaa" })).toBe("Buka aaa")
    expect(translate("en", "Open {name}", { name: "aaa" })).toBe("Open aaa")
    expect(translate("id", "A sentence with no entry")).toBe("A sentence with no entry")
    expect(translate("en", "Hi {missing}", {})).toBe("Hi {missing}")
  })
})

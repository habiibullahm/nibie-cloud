import { describe, expect, it } from "vitest"
import { formatPriceIdr } from "@/lib/format"
import {
  formatBytesId,
  formatDateTimeId,
  formatUsd,
  instanceStatusId,
  paymentPurposeId,
  paymentStatusId,
  subscriptionStatusId,
} from "@/lib/admin-format"

describe("customer price", () => {
  it("shows a plan without a price as free during the beta", () => {
    expect(formatPriceIdr(null)).toBe("Free during the beta")
  })
})

describe("admin empty values", () => {
  it("never uses an em dash", () => {
    for (const v of [formatDateTimeId(null), formatBytesId(null), formatBytesId("x"), formatUsd(null)]) {
      expect(v).not.toContain("—")
    }
  })
})

describe("admin enum labels", () => {
  it("translates known backend values to Indonesian", () => {
    expect(instanceStatusId("ACTIVE")).toBe("Aktif")
    expect(subscriptionStatusId("GRACE")).toBe("Masa tenggang")
    expect(paymentStatusId("PAID")).toBe("Dibayar")
    expect(paymentPurposeId("RENEWAL")).toBe("Perpanjangan")
    expect(paymentPurposeId("PLAN_CHANGE")).toBe("Ganti paket")
  })

  it("shows an unknown value raw instead of hiding it", () => {
    expect(subscriptionStatusId("SOMETHING_NEW")).toBe("SOMETHING_NEW")
  })
})

import { describe, expect, it } from "vitest"
import type { BillingPayment, BillingSubscription } from "../src/lib/api/types"
import {
  billingNotice,
  billingStatusLabel,
  canCancelRenewal,
  canRenew,
  deployAgainHref,
  evaluateReturn,
  isPendingPurchase,
  isRenewal,
  newestOrder,
  retryHref,
  payableUrl,
  subscriptionOfInstance,
} from "../src/lib/billing"

const NOW = Date.parse("2026-11-15T00:00:00Z")
const HOUR = 3_600_000

function payment(over: Partial<BillingPayment> = {}): BillingPayment {
  return {
    id: "p1",
    subscriptionId: "s1",
    status: "PENDING",
    purpose: "NEW",
    amountIdr: 25000,
    paymentUrl: "https://pay.example.test/x",
    expiresAt: new Date(NOW + HOUR).toISOString(),
    paidAt: null,
    ...over,
  }
}
function sub(over: Partial<BillingSubscription> = {}): BillingSubscription {
  return {
    id: "s1",
    planId: "plan",
    planName: "Hosting",
    instanceId: "i1",
    name: "agent",
    status: "ACTIVE",
    currentPeriodEnd: new Date(NOW + 10 * 24 * HOUR).toISOString(),
    cancelAtPeriodEnd: false,
    graceEndsAt: null,
    retentionEndsAt: null,
    createdAt: new Date(NOW - 20 * 24 * HOUR).toISOString(),
    latestPayment: null,
    ...over,
  }
}

describe("billingStatusLabel", () => {
  it("says every status in words", () => {
    expect(billingStatusLabel("PENDING_PAYMENT", false)).toBe("Awaiting payment")
    expect(billingStatusLabel("ACTIVE", false)).toBe("Active")
    expect(billingStatusLabel("ACTIVE", true)).toBe("Active, renewal cancelled")
    expect(billingStatusLabel("GRACE", false)).toBe("Payment overdue (grace period)")
    expect(billingStatusLabel("SUSPENDED", false)).toBe("Suspended")
    expect(billingStatusLabel("ENDED", false)).toBe("Ended")
  })
})

describe("payableUrl", () => {
  it("returns the URL only for a pending, unexpired invoice", () => {
    expect(payableUrl(payment(), NOW)).toBe("https://pay.example.test/x")
    expect(payableUrl(payment({ status: "PAID" }), NOW)).toBeNull()
    expect(payableUrl(payment({ status: "FAILED" }), NOW)).toBeNull()
    expect(payableUrl(payment({ expiresAt: new Date(NOW - 1).toISOString() }), NOW)).toBeNull()
    expect(payableUrl(payment({ paymentUrl: null }), NOW)).toBeNull()
    expect(payableUrl(null, NOW)).toBeNull()
  })
})

describe("renewal rules", () => {
  it("offers renew while running, late or suspended, and not otherwise", () => {
    expect(canRenew(sub())).toBe(true)
    expect(canRenew(sub({ status: "GRACE" }))).toBe(true)
    expect(canRenew(sub({ status: "SUSPENDED" }))).toBe(true)
    expect(canRenew(sub({ status: "ENDED" }))).toBe(false)
    expect(canRenew(sub({ status: "PENDING_PAYMENT", instanceId: null }))).toBe(false)
  })
  it("offers cancel only when renewal is still scheduled", () => {
    expect(canCancelRenewal(sub())).toBe(true)
    expect(canCancelRenewal(sub({ cancelAtPeriodEnd: true }))).toBe(false)
    expect(canCancelRenewal(sub({ status: "ENDED" }))).toBe(false)
  })
})

describe("billingNotice", () => {
  it("is empty for a healthy or missing subscription", () => {
    expect(billingNotice(null)).toBeNull()
    expect(billingNotice(sub())).toBeNull()
    expect(billingNotice(sub({ cancelAtPeriodEnd: true }))).toBeNull()
  })
  it("warns during grace with the end date", () => {
    const n = billingNotice(sub({ status: "GRACE", graceEndsAt: "2026-11-18T00:00:00Z" }))
    expect(n?.kind).toBe("grace")
    expect(n?.body).toContain("18 November 2026")
  })
  it("states the deletion date when suspended", () => {
    const n = billingNotice(sub({ status: "SUSPENDED", retentionEndsAt: "2026-12-10T00:00:00Z" }))
    expect(n?.kind).toBe("suspended")
    expect(n?.title).toContain("scheduled for deletion")
    expect(n?.body).toContain("10 December 2026")
    expect(n?.renewLabel).toBe("Renew now to prevent deletion")
  })
  it("does not invent a date when the backend sent none", () => {
    expect(billingNotice(sub({ status: "SUSPENDED" }))?.body).toContain("limited time")
  })
})

describe("purchases and lookup", () => {
  it("recognises a purchase without an instance", () => {
    expect(isPendingPurchase(sub({ status: "PENDING_PAYMENT", instanceId: null }))).toBe(true)
    expect(isPendingPurchase(sub())).toBe(false)
  })
  it("finds the subscription of an instance", () => {
    const subs = [sub({ id: "a", instanceId: "i1" }), sub({ id: "b", instanceId: "i2" })]
    expect(subscriptionOfInstance(subs, "i2")?.id).toBe("b")
    expect(subscriptionOfInstance(subs, "zz")).toBeNull()
    expect(subscriptionOfInstance(undefined, "i1")).toBeNull()
  })
})

describe("evaluateReturn", () => {
  const pending = (p: BillingPayment | null) => sub({ status: "PENDING_PAYMENT", instanceId: null, latestPayment: p })
  it("is paid when no purchase is left waiting", () => {
    expect(evaluateReturn([sub()], NOW)).toBe("paid")
    expect(evaluateReturn([], NOW)).toBe("paid")
  })
  it("is waiting while the invoice is still payable", () => {
    expect(evaluateReturn([pending(payment())], NOW)).toBe("waiting")
  })
  it("is failed when the invoice failed, expired or is missing", () => {
    expect(evaluateReturn([pending(payment({ status: "FAILED" }))], NOW)).toBe("failed")
    expect(evaluateReturn([pending(payment({ status: "EXPIRED" }))], NOW)).toBe("failed")
    expect(evaluateReturn([pending(payment({ expiresAt: new Date(NOW - 1).toISOString() }))], NOW)).toBe("failed")
    expect(evaluateReturn([pending(null)], NOW)).toBe("failed")
  })
  it("judges the newest invoice, not older abandoned purchases", () => {
    const old = pending(payment({ status: "EXPIRED", expiresAt: new Date(NOW - 2 * HOUR).toISOString() }))
    const paid = sub({ latestPayment: payment({ status: "PAID", expiresAt: new Date(NOW + HOUR).toISOString() }) })
    expect(evaluateReturn([paid, old], NOW)).toBe("paid")
    expect(evaluateReturn([old, pending(payment())], NOW)).toBe("waiting")
  })
})

describe("newestOrder and deployAgainHref", () => {
  it("picks the subscription with the latest invoice and skips ones without a payment", () => {
    const old = sub({ id: "old", latestPayment: payment({ expiresAt: new Date(NOW - HOUR).toISOString() }) })
    const fresh = sub({ id: "fresh", latestPayment: payment({ expiresAt: new Date(NOW + HOUR).toISOString() }) })
    expect(newestOrder([old, sub({ id: "none", latestPayment: null }), fresh])?.id).toBe("fresh")
    expect(newestOrder([sub({ latestPayment: null })])).toBeNull()
  })
  it("prefills the deploy form with the order's name and plan, encoded", () => {
    expect(deployAgainHref({ name: "my bot & co", planId: "p1" })).toBe("/deploy?name=my+bot+%26+co&plan=p1")
  })
})

describe("isRenewal and retryHref", () => {
  const renewal = sub({ instanceId: "i1", planId: "p1", name: "bot", latestPayment: payment({ purpose: "RENEWAL" }) })
  const fresh = sub({ status: "PENDING_PAYMENT", instanceId: null, planId: "p1", name: "bot", latestPayment: payment({ purpose: "NEW" }) })
  it("tells a renewal of an existing instance from a new order", () => {
    expect(isRenewal(renewal)).toBe(true)
    expect(isRenewal(fresh)).toBe(false)
    expect(isRenewal(null)).toBe(false)
  })
  it("retries a renewal on its billing page and a new order on Deploy", () => {
    expect(retryHref(renewal)).toBe("/instances/i1/billing")
    expect(retryHref(fresh)).toBe("/deploy?name=bot&plan=p1")
  })
})

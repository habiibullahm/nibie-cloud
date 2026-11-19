import { describe, expect, it } from "vitest"
import type { WalletTopup } from "../src/lib/api/types"
import { isPayable, parseAdjustAmount, parseTopupAmount } from "../src/lib/wallet"

const limits = { topupMinIdr: 10_000, topupMaxIdr: 2_000_000, maxBalanceIdr: 5_000_000 }

describe("parseTopupAmount", () => {
  it("accepts whole rupiah with or without thousands separators", () => {
    expect(parseTopupAmount("50000", limits)).toEqual({ ok: true, value: 50_000 })
    expect(parseTopupAmount("50.000", limits)).toEqual({ ok: true, value: 50_000 })
    expect(parseTopupAmount(" 1,000,000 ", limits)).toEqual({ ok: true, value: 1_000_000 })
  })

  it("refuses empty, non-numbers, decimals and amounts outside the limits", () => {
    expect(parseTopupAmount("", limits)).toEqual({ ok: false, reason: "empty" })
    expect(parseTopupAmount("abc", limits)).toEqual({ ok: false, reason: "not_number" })
    expect(parseTopupAmount("-10000", limits)).toEqual({ ok: false, reason: "not_number" })
    expect(parseTopupAmount("9999", limits)).toEqual({ ok: false, reason: "too_low" })
    expect(parseTopupAmount("2000001", limits)).toEqual({ ok: false, reason: "too_high" })
  })
})

describe("parseAdjustAmount", () => {
  it("reads signed whole rupiah within the admin limit and refuses zero", () => {
    expect(parseAdjustAmount("10.000")).toBe(10_000)
    expect(parseAdjustAmount("-5000")).toBe(-5_000)
    expect(parseAdjustAmount("+2.000.000")).toBe(2_000_000)
    expect(parseAdjustAmount("0")).toBeNull()
    expect(parseAdjustAmount("2000001")).toBeNull()
    expect(parseAdjustAmount("1,5")).toBe(15)
    expect(parseAdjustAmount("abc")).toBeNull()
    expect(parseAdjustAmount("")).toBeNull()
  })
})

describe("isPayable", () => {
  const t = (o: Partial<WalletTopup>): WalletTopup => ({
    id: "t", amountIdr: 10_000, status: "PENDING", paymentUrl: "https://pay.test/x",
    expiresAt: new Date(Date.now() + 60_000).toISOString(), paidAt: null, createdAt: new Date().toISOString(), ...o,
  })
  it("is true only for a pending top-up with a link that has not expired", () => {
    expect(isPayable(t({}))).toBe(true)
    expect(isPayable(t({ status: "PAID" }))).toBe(false)
    expect(isPayable(t({ paymentUrl: null }))).toBe(false)
    expect(isPayable(t({ expiresAt: new Date(Date.now() - 1).toISOString() }))).toBe(false)
  })
})

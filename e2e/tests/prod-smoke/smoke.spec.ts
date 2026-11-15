import { expect, test } from "@playwright/test"
import { optional } from "../../support/env"

// Read-only checks against production. Nothing here creates, changes or deletes anything.
const API = process.env.PROD_API_URL ?? "https://api.cloud.nibie.app"

test("the landing page, pricing and legal pages answer 200", async ({ request }) => {
  for (const path of ["/", "/harga", "/kontak", "/syarat-layanan", "/kebijakan-refund", "/kebijakan-privasi"]) {
    expect((await request.get(path)).status(), path).toBe(200)
  }
})

test("the dashboard sign-in page opens", async ({ page }) => {
  await page.goto("/dashboard/sign-in")
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible()
})

test("the API answers its health check", async ({ request }) => {
  const res = await request.get(`${API}/healthz`)
  expect(res.status()).toBe(200)
  expect(await res.json()).toEqual({ status: "ok" })
})

test("the smoke account can sign in and open its instance list", async ({ page }) => {
  const email = optional("PROD_SMOKE_EMAIL")
  const password = optional("PROD_SMOKE_PASSWORD")
  test.skip(!email || !password, "PROD_SMOKE_EMAIL and PROD_SMOKE_PASSWORD are not set")
  await page.goto("/dashboard/sign-in")
  await page.getByLabel("Email").fill(email!)
  await page.getByLabel("Password").fill(password!)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL(/\/dashboard\/instances$/)
  await expect(page.getByRole("heading", { name: "Instances" })).toBeVisible()
  await expect(page.getByRole("alert")).toHaveCount(0)
})

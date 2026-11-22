import { spawnSync } from "node:child_process"
import { expect, test } from "@playwright/test"
import { REPO_DIR } from "./helpers"

test("billing checkout, webhook fulfillment, upgrade limit, and waitlist reservation place onto jkt-2", () => {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
  const res = spawnSync(pnpm, ["exec", "tsx", "test/validation/fleet-billing-e2e.ts"], {
    cwd: REPO_DIR,
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 90_000,
  })
  expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0)
})

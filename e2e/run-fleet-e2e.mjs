import { execFileSync, spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const rebuild = args.includes("--rebuild") ? ["--rebuild"] : []
const passthrough = args.filter((a) => a !== "--rebuild" && a !== "--down")
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

execFileSync(process.execPath, [resolve(__dirname, "support/fleet-prep.mjs"), ...rebuild], {
  cwd: __dirname,
  stdio: "inherit",
})

const testRun = spawnSync(
  pnpm,
  ["exec", "playwright", "test", "-c", "playwright.fleet.config.ts", ...passthrough],
  {
    cwd: __dirname,
    stdio: "inherit",
    shell: process.platform === "win32",
  },
)

if (args.includes("--down")) {
  execFileSync(process.execPath, [resolve(__dirname, "support/local-fleet.mjs"), "down"], {
    cwd: __dirname,
    stdio: "inherit",
  })
  execFileSync(process.execPath, [resolve(__dirname, "support/local-auth-stack.mjs"), "down"], {
    cwd: __dirname,
    stdio: "inherit",
  })
}

process.exit(testRun.status ?? 1)

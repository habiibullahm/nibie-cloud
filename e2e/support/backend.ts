import { execFileSync } from "node:child_process"
import { BACKEND_URL } from "./env"

/** Customer API calls from Node, as the test user. Used for cleanup and for checks the UI cannot show. */
async function api<T>(token: string, method: string, path: string): Promise<T> {
  const res = await fetch(`${BACKEND_URL}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}`)
  return (await res.json()) as T
}

export interface InstanceRow { id: string; name: string; status: string }

export async function listInstances(token: string): Promise<InstanceRow[]> {
  return (await api<{ instances: InstanceRow[] }>(token, "GET", "/instances")).instances
}

/** Deletes every instance of the user and waits until the list is empty. */
export async function deleteAllInstances(token: string): Promise<void> {
  for (const i of await listInstances(token)) {
    if (i.status !== "DELETING" && i.status !== "DELETED") await api(token, "DELETE", `/instances/${i.id}`).catch(() => undefined)
  }
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if ((await listInstances(token)).every((i) => i.status === "DELETED")) return
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error("Instances were not deleted within 60 seconds")
}

/** Docker facts about a tenant container, by the names the backend derives from the instance id. */
export function containerState(instanceId: string): "running" | "stopped" | "absent" {
  const out = execFileSync("docker", ["ps", "-a", "--filter", `name=^hermes-${instanceId}$`, "--format", "{{.State}}"], { encoding: "utf8" }).trim()
  if (!out) return "absent"
  return out === "running" ? "running" : "stopped"
}

export function volumeExists(instanceId: string): boolean {
  return execFileSync("docker", ["volume", "ls", "--filter", `name=^hermes-data-${instanceId}$`, "--format", "{{.Name}}"], { encoding: "utf8" }).trim() !== ""
}

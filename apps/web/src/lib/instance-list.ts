import type { Instance, InstanceStatus } from "./api/types"

/** Filter groups on the Instances page. Labels are English source text for t(). */
export type InstanceGroup = "all" | "running" | "busy" | "stopped" | "problem"
export const GROUPS: { value: InstanceGroup; label: string }[] = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "busy", label: "In progress" },
  { value: "stopped", label: "Stopped" },
  { value: "problem", label: "Needs attention" },
]

export function groupOf(status: InstanceStatus): Exclude<InstanceGroup, "all"> {
  switch (status) {
    case "ACTIVE":
      return "running"
    case "DEGRADED":
    case "FAILED":
      return "problem"
    case "STOPPED":
    case "SUSPENDED":
    case "DELETED":
      return "stopped"
    default:
      return "busy"
  }
}

export type InstanceSort = "active" | "newest" | "name"
export const SORTS: { value: InstanceSort; label: string }[] = [
  { value: "active", label: "Active first" },
  { value: "newest", label: "Newest first" },
  { value: "name", label: "Name (A to Z)" },
]

/** "Active first": running, then needs attention, in progress, stopped. Ties: newest first. */
const RANK: Record<Exclude<InstanceGroup, "all">, number> = { running: 0, problem: 1, busy: 2, stopped: 3 }

export function arrangeInstances(list: Instance[], group: InstanceGroup, sort: InstanceSort): Instance[] {
  const newest = (a: Instance, b: Instance) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
  return list
    .filter((i) => group === "all" || groupOf(i.status) === group)
    .sort(
      sort === "name"
        ? (a, b) => a.name.localeCompare(b.name)
        : sort === "newest"
          ? newest
          : (a, b) => RANK[groupOf(a.status)] - RANK[groupOf(b.status)] || newest(a, b)
    )
}

export function countByGroup(list: Instance[]): Record<InstanceGroup, number> {
  const c: Record<InstanceGroup, number> = { all: list.length, running: 0, busy: 0, stopped: 0, problem: 0 }
  for (const i of list) c[groupOf(i.status)]++
  return c
}

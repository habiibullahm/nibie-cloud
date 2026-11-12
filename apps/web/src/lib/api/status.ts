import type { InstanceStatus } from "./types"

/** Customer-facing labels (PRD §4.4). Internal states are folded in, never shown raw. */
export type StatusTone = "ok" | "warn" | "neutral" | "busy" | "danger"

export interface StatusPresentation {
  label: string
  tone: StatusTone
  /** Shown when the backend gives no reason. Non-sensitive, actionable. */
  defaultReason: string | null
  nextAction: string | null
}

const P: Record<InstanceStatus, StatusPresentation> = {
  PENDING: {
    label: "Pending",
    tone: "busy",
    defaultReason: "Your deployment is queued.",
    nextAction: null,
  },
  PROVISIONING: {
    label: "Provisioning",
    tone: "busy",
    defaultReason: "Creating your runtime and persistent storage.",
    nextAction: null,
  },
  // Internal step between provisioning and start; customers see it as Provisioning.
  CONFIGURING: {
    label: "Provisioning",
    tone: "busy",
    defaultReason: "Applying your configuration.",
    nextAction: null,
  },
  STARTING: {
    label: "Starting",
    tone: "busy",
    defaultReason: "Starting Hermes and waiting for the health check.",
    nextAction: null,
  },
  ACTIVE: { label: "Active", tone: "ok", defaultReason: null, nextAction: null },
  DEGRADED: {
    label: "Degraded",
    tone: "warn",
    defaultReason: "Hermes is running but failed recent health checks.",
    nextAction:
      "Automatic recovery is retrying. If it persists, restart the instance or check the logs.",
  },
  STOPPING: {
    label: "Stopping",
    tone: "busy",
    defaultReason: "Stopping the runtime. Your data is kept.",
    nextAction: null,
  },
  STOPPED: {
    label: "Stopped",
    tone: "neutral",
    defaultReason: "Stopped by you. Your data is kept.",
    nextAction: "Start the instance when you need it again.",
  },
  SUSPENDED: {
    label: "Suspended",
    tone: "warn",
    defaultReason: "Your subscription has ended. Data is kept for 30 days.",
    nextAction: "Renew your plan to restore the instance.",
  },
  FAILED: {
    label: "Failed",
    tone: "danger",
    defaultReason: "The last operation did not complete.",
    nextAction: "Retry the deployment, or contact support on Telegram if it keeps failing.",
  },
  DELETING: {
    label: "Deleting",
    tone: "busy",
    defaultReason: "Removing the runtime and its data.",
    nextAction: null,
  },
  DELETED: {
    label: "Deleted",
    tone: "neutral",
    defaultReason: "This instance has been deleted.",
    nextAction: null,
  },
}

export function presentStatus(status: InstanceStatus): StatusPresentation {
  return P[status]
}

export const TRANSITIONAL: ReadonlySet<InstanceStatus> = new Set([
  "PENDING",
  "PROVISIONING",
  "CONFIGURING",
  "STARTING",
  "STOPPING",
  "DELETING",
])

export function isTransitional(status: InstanceStatus): boolean {
  return TRANSITIONAL.has(status)
}

export type InstanceAction = "start" | "stop" | "restart" | "delete"

/** Mirrors the backend's guards in InstanceService (start/stop/restart/delete). */
export function allowedActions(status: InstanceStatus): ReadonlySet<InstanceAction> {
  switch (status) {
    case "ACTIVE":
    case "DEGRADED":
      return new Set(["stop", "restart", "delete"])
    case "STOPPED":
      return new Set(["start", "delete"])
    case "FAILED":
      return new Set(["delete"])
    default:
      return new Set()
  }
}

/** Shell and file access need a running runtime. */
export function runtimeReachable(status: InstanceStatus): boolean {
  return status === "ACTIVE" || status === "DEGRADED"
}

/** Ordered steps for the provisioning progress indicator. */
export const PROVISION_STEPS: { status: InstanceStatus[]; label: string }[] = [
  { status: ["PENDING"], label: "Queued" },
  { status: ["PROVISIONING"], label: "Creating runtime and storage" },
  { status: ["CONFIGURING"], label: "Applying configuration" },
  { status: ["STARTING"], label: "Starting Hermes" },
  { status: ["ACTIVE", "DEGRADED"], label: "Health check passed" },
]

export function provisionStepIndex(status: InstanceStatus): number {
  return PROVISION_STEPS.findIndex((s) => s.status.includes(status))
}

/**
 * What the admin shell should draw. Pure, so the decision table can be tested without a DOM — the
 * component is a thin wrapper around this.
 *
 * The order matters: a missing backend beats a loading state (mock mode never fetches), and an
 * outage must not read as "not an admin".
 */
export type AdminGateDecision = "needs-backend" | "loading" | "mfa" | "unauthorized" | "panel"

export interface AdminGateInput {
  mode: "mock" | "live" | "customer"
  pending: boolean
  error: boolean
  admin: { email: string; aal: "aal1" | "aal2" } | null
  /** The backend answered `mfa_required`: an admin whose session has no second factor yet. Absent: false. */
  mfaRequired?: boolean
}

export function decideAdminGate(i: AdminGateInput): AdminGateDecision {
  // The panel has no mock data on purpose: invented customers would be worse than an empty screen.
  if (i.mode !== "customer") return "needs-backend"
  if (i.pending || i.error) return "loading"
  // Only an allowlisted admin ever gets `mfa_required`; everyone else gets a plain 403.
  if (i.mfaRequired) return "mfa"
  if (!i.admin) return "unauthorized"
  return "panel"
}

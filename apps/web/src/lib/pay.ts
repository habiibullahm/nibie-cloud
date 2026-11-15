import { toast } from "sonner"
import { MOCK_PAYMENT_URL } from "./api/mock"

/**
 * Sends the browser to the Duitku payment page. Returns false (and tells the customer why) when it cannot:
 * mock mode has no payment page, and anything that is not an https URL is refused instead of followed.
 */
export function startPayment(url: string | null): boolean {
  if (!url) {
    toast.error("This invoice can no longer be paid. Start a new payment.")
    return false
  }
  if (url === MOCK_PAYMENT_URL) {
    toast.info("Preview mode has no payment page. With the real API this opens Duitku.")
    return false
  }
  let target: URL
  try {
    target = new URL(url)
  } catch {
    toast.error("The payment page address is invalid.")
    return false
  }
  if (target.protocol !== "https:") {
    toast.error("The payment page address is not secure, so it was not opened.")
    return false
  }
  window.location.assign(target.toString())
  return true
}

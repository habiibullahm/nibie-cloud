import { toast } from "sonner"

/** Copies text and says whether it worked; the clipboard can be blocked by the browser. */
export async function copyWithToast(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copied`)
  } catch {
    toast.error(`Could not copy the ${what}. Select it and copy it yourself.`)
  }
}

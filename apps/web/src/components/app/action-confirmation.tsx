"use client"

import { createContext, useContext, useRef, useState } from "react"
import { usePathname } from "next/navigation"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { useT } from "@/lib/i18n"

interface Confirmation {
  title: string
  description: string
  label: string
  destructive?: boolean
  run: () => void
}

type Request = Confirmation & { cancelLabel: string; pathname: string }

const ConfirmationContext = createContext<((action: Confirmation, cancelLabel: string) => void) | null>(null)

export function useActionConfirmation() {
  const confirm = useContext(ConfirmationContext)
  const t = useT()
  if (!confirm) throw new Error("ActionConfirmation is missing")
  return (action: Confirmation) => confirm(action, t("Cancel"))
}

export function ActionConfirmation({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [action, setAction] = useState<Request | null>(null)
  const pending = useRef<Request | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)

  if (action && action.pathname !== pathname) setAction(null)

  function request(next: Confirmation, cancelLabel: string) {
    if (pending.current?.pathname === pathname) return
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const nextAction = { ...next, cancelLabel, pathname }
    pending.current = nextAction
    setAction(nextAction)
  }

  return (
    <ConfirmationContext.Provider value={request}>
      {children}
      <AlertDialog open={action !== null} onOpenChange={(open) => {
        if (!open) {
          pending.current = null
          setAction(null)
        }
      }}>
        <AlertDialogContent onCloseAutoFocus={(event) => {
          if (pending.current?.pathname !== pathname) pending.current = null
          const element = returnFocus.current
          if (element?.isConnected) {
            event.preventDefault()
            element.focus()
          }
        }}>
          <AlertDialogHeader>
            <AlertDialogTitle>{action?.title}</AlertDialogTitle>
            <AlertDialogDescription className="wrap-anywhere">{action?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{action?.cancelLabel}</AlertDialogCancel>
            <AlertDialogAction variant={action?.destructive ? "destructive" : "default"} onClick={() => {
              const confirmed = pending.current
              pending.current = null
              if (confirmed?.pathname === pathname) confirmed.run()
            }}>
              {action?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmationContext.Provider>
  )
}

"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { Play, RotateCw, Square, Terminal, Trash2 } from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { useActionConfirmation } from "@/components/app/action-confirmation"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { Instance } from "@/lib/api/types"
import { allowedActions, runtimeReachable } from "@/lib/api/status"
import { useApiMode, useInstanceAction } from "@/hooks/use-hermes"
import { useT } from "@/lib/i18n"

/** Restart, stop/start, open console, delete. Buttons that are not allowed are hidden, not faked. */
export function InstanceActions({
  instance,
  compact = false,
  suspended = false,
}: {
  instance: Instance
  compact?: boolean
  /** Subscription suspended: the backend refuses start, so the button is hidden; renewing is the way back. */
  suspended?: boolean
}) {
  const t = useT()
  const allowed = allowedActions(instance.status)
  const action = useInstanceAction(instance.id)
  const confirm = useActionConfirmation()
  const [deleting, setDeleting] = useState(false)
  const busy = action.isPending
  // The console has no backend yet: in customer mode it would open sample data, so the button is not shown.
  const consoleAvailable = useApiMode() !== "customer"

  return (
    <>
      {runtimeReachable(instance.status) && !compact && consoleAvailable ? (
        <Button asChild variant="outline">
          <Link href={`/instances/${instance.id}/console`}>
            <Terminal aria-hidden="true" />
            {t("Open console")}
          </Link>
        </Button>
      ) : null}
      {/* Secondary like Restart and Stop: the page's one terracotta button belongs to its main task (Connect Telegram, Renew now). */}
      {allowed.has("start") && !suspended ? (
        <Button variant="secondary" disabled={busy} onClick={() => confirm({
          title: t("Start instance?"),
          description: t("Start Hermes on {name}.", { name: instance.name }),
          label: t("Start"),
          run: () => action.mutate("start"),
        })}>
          <Play aria-hidden="true" />
          {t("Start")}
        </Button>
      ) : null}
      {allowed.has("restart") ? (
        <Button variant="secondary" disabled={busy} onClick={() => confirm({
          title: t("Restart instance?"),
          description: t("{name} will be unavailable for a moment while Hermes restarts. Active sessions are interrupted.", { name: instance.name }),
          label: t("Restart"),
          run: () => action.mutate("restart"),
        })}>
          <RotateCw aria-hidden="true" />
          {t("Restart")}
        </Button>
      ) : null}
      {allowed.has("stop") ? (
        <Button variant="secondary" disabled={busy} onClick={() => confirm({
          title: t("Stop instance?"),
          description: t("{name} will stop answering until you start it again. Your files and configuration are kept.", { name: instance.name }),
          label: t("Stop instance"),
          destructive: true,
          run: () => action.mutate("stop"),
        })}>
          <Square aria-hidden="true" />
          {t("Stop")}
        </Button>
      ) : null}
      {allowed.has("delete") && !compact ? (
        <Button variant="ghost" disabled={busy} onClick={() => setDeleting(true)} aria-label={t("Delete {name}", { name: instance.name })}>
          <Trash2 aria-hidden="true" />
          {t("Delete")}
        </Button>
      ) : null}

      <DeleteInstanceDialog instance={instance} open={deleting} onOpenChange={setDeleting} />
    </>
  )
}

export function DeleteInstanceDialog({
  instance,
  open,
  onOpenChange,
}: {
  instance: Instance
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useT()
  const [typed, setTyped] = useState("")
  const action = useInstanceAction(instance.id)
  const router = useRouter()
  const matches = typed.trim() === instance.name

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setTyped("")
        onOpenChange(o)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Delete instance?")}</DialogTitle>
          <DialogDescription>
            {t("This stops {name} and permanently deletes its runtime, files and stored credentials. Backups follow the backup retention policy. This cannot be undone.", { name: instance.name })}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!matches) return
            action.mutate("delete", {
              onSuccess: () => {
                onOpenChange(false)
                router.push("/instances")
              },
            })
          }}
        >
          <Label htmlFor="confirm-name">
            {t("Type the name to confirm:")} <span className="type-mono">{instance.name}</span>
          </Label>
          <Input
            id="confirm-name"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="type-mono"
          />
          <DialogFooter className="pt-4">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t("Cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" variant="destructive" disabled={!matches || action.isPending}>
              <Trash2 aria-hidden="true" />
              {t("Delete instance")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

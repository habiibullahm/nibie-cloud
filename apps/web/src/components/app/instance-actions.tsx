"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { Play, RotateCw, Square, Terminal, Trash2 } from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
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
import { useInstanceAction } from "@/hooks/use-hermes"

/** Restart, stop/start, open console, delete. Buttons that are not allowed are hidden, not faked. */
export function InstanceActions({ instance, compact = false }: { instance: Instance; compact?: boolean }) {
  const allowed = allowedActions(instance.status)
  const action = useInstanceAction(instance.id)
  const [confirm, setConfirm] = useState<null | "stop" | "restart">(null)
  const [deleting, setDeleting] = useState(false)
  const busy = action.isPending

  return (
    <>
      {runtimeReachable(instance.status) && !compact ? (
        <Button asChild variant="outline">
          <Link href={`/instances/${instance.id}/console`}>
            <Terminal aria-hidden="true" />
            Open console
          </Link>
        </Button>
      ) : null}
      {allowed.has("start") ? (
        <Button variant="default" disabled={busy} onClick={() => action.mutate("start")}>
          <Play aria-hidden="true" />
          Start
        </Button>
      ) : null}
      {allowed.has("restart") ? (
        <Button variant="secondary" disabled={busy} onClick={() => setConfirm("restart")}>
          <RotateCw aria-hidden="true" />
          Restart
        </Button>
      ) : null}
      {allowed.has("stop") ? (
        <Button variant="secondary" disabled={busy} onClick={() => setConfirm("stop")}>
          <Square aria-hidden="true" />
          Stop
        </Button>
      ) : null}
      {allowed.has("delete") && !compact ? (
        <Button variant="ghost" disabled={busy} onClick={() => setDeleting(true)} aria-label={`Delete ${instance.name}`}>
          <Trash2 aria-hidden="true" />
          Delete
        </Button>
      ) : null}

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "stop" ? "Stop instance?" : "Restart instance?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "stop"
                ? `${instance.name} will stop answering until you start it again. Your files and configuration are kept.`
                : `${instance.name} will be unavailable for a moment while Hermes restarts. Active sessions are interrupted.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirm) action.mutate(confirm)
                setConfirm(null)
              }}
            >
              {confirm === "stop" ? "Stop instance" : "Restart"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
          <DialogTitle>Delete instance?</DialogTitle>
          <DialogDescription>
            This stops {instance.name} and permanently deletes its runtime, files and stored credentials. Backups
            follow the backup retention policy. This cannot be undone.
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
            Type <span className="type-mono">{instance.name}</span> to confirm
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
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="destructive" disabled={!matches || action.isPending}>
              <Trash2 aria-hidden="true" />
              Delete instance
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

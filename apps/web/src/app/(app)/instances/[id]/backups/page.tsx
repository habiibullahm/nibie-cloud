"use client"

import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Archive, Check, CircleX, Loader2 } from "lucide-react"
import { toast } from "sonner"
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
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { PreviewNote } from "@/components/app/preview-note"
import { errorMessage, keys, useBackups } from "@/hooks/use-hermes"
import { getApi, type Backup } from "@/lib/api"
import { formatDateTime } from "@/lib/format"
import { useInstanceId } from "../instance-frame"

const KIND: Record<Backup["kind"], string> = { scheduled: "Scheduled", manual: "Manual", "pre-upgrade": "Before upgrade" }

export default function BackupsPage() {
  const id = useInstanceId()
  const backups = useBackups(id)
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [restore, setRestore] = useState<Backup | null>(null)
  const running = backups.data?.some((b) => b.status === "running")

  const create = async () => {
    setCreating(true)
    try {
      await getApi().preview.createBackup(id)
      await qc.invalidateQueries({ queryKey: keys.backups(id) })
      toast.success("Backup started")
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Backups</CardTitle>
        <CardDescription>Encrypted copies of your volume, stored outside the runtime node.</CardDescription>
        <CardAction className="flex flex-wrap items-center gap-2">
          <PreviewNote what="Backups" />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-muted-foreground">Scheduled daily. Retention follows your plan.</p>
          <Button onClick={create} disabled={creating || running}>
            <Archive aria-hidden="true" />
            {running ? "Backup running…" : "Back up now"}
          </Button>
        </div>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead>Checksum</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {backups.isLoading ? (
                <TableRow>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-6 bg-elevated" />
                  </TableCell>
                </TableRow>
              ) : backups.data?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground">
                    No backups yet. The first scheduled backup runs within 24 hours.
                  </TableCell>
                </TableRow>
              ) : (
                backups.data?.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell>{formatDateTime(b.createdAt)}</TableCell>
                    <TableCell>{KIND[b.kind]}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-2">
                        {b.status === "completed" ? (
                          <Check className="size-4" aria-hidden="true" />
                        ) : b.status === "running" ? (
                          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                        ) : (
                          <CircleX className="size-4 text-destructive" aria-hidden="true" />
                        )}
                        {b.status === "completed" ? "Completed" : b.status === "running" ? "Running" : "Failed"}
                      </span>
                    </TableCell>
                    <TableCell className="type-mono text-right">{b.sizeMb} MB</TableCell>
                    <TableCell className="type-mono text-muted-foreground">{b.checksum}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" disabled={b.status !== "completed"} onClick={() => setRestore(b)}>
                        Restore
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>

      <AlertDialog open={restore !== null} onOpenChange={(o) => !o && setRestore(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore this backup?</AlertDialogTitle>
            <AlertDialogDescription>
              {restore
                ? `We restore the backup from ${formatDateTime(restore.createdAt)} into a fresh volume, verify it, then switch your instance over. Changes made after that time are lost.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                toast.info("Restore is not available in the preview yet")
                setRestore(null)
              }}
            >
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

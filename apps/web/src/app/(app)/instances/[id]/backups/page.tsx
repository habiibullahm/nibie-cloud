"use client"

import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Archive, Check, CircleX, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ComingSoon } from "@/components/app/coming-soon"
import { PreviewNote } from "@/components/app/preview-note"
import { QueryFallback } from "@/components/app/query-fallback"
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
        {/* Storage and encryption follow PRD §12. */}
        <CardDescription>Encrypted copies of your volume, stored outside the runtime node.</CardDescription>
        <CardAction className="flex flex-wrap items-center gap-2">
          <PreviewNote what="Backups" />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-muted-foreground">Retention follows your plan.</p>
          <Button onClick={create} disabled={creating || running}>
            <Archive aria-hidden="true" />
            {running ? "Backup running…" : "Back up now"}
          </Button>
        </div>
        {/* TODO(backups): restore needs the backup API (PRD §12); then add a confirm dialog per row. */}
        <div className="flex flex-wrap items-center gap-3 text-muted-foreground">
          <ComingSoon />
          <p>Restoring a backup arrives with the backup API.</p>
        </div>
        {!backups.data ? (
          <QueryFallback what="backups" queries={[backups]} className="h-24" />
        ) : backups.data.length === 0 ? (
          <p className="text-muted-foreground">No backups yet. Use Back up now to create the first one.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Created</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead>Checksum</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {backups.data.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell>{formatDateTime(b.createdAt)}</TableCell>
                    <TableCell>{KIND[b.kind]}</TableCell>
                    <TableCell>
                      <BackupStatus status={b.status} />
                    </TableCell>
                    <TableCell className="type-mono text-right">{b.sizeMb} MB</TableCell>
                    <TableCell className="type-mono text-muted-foreground">{b.checksum}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function BackupStatus({ status }: { status: Backup["status"] }) {
  return (
    <span className="inline-flex items-center gap-2">
      {status === "completed" ? (
        <Check className="size-4" aria-hidden="true" />
      ) : status === "running" ? (
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        <CircleX className="size-4 text-destructive" aria-hidden="true" />
      )}
      {status === "completed" ? "Completed" : status === "running" ? "Running" : "Failed"}
    </span>
  )
}

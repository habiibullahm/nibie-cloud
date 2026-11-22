"use client"

import { useState } from "react"
import Link from "next/link"
import { useQueryClient } from "@tanstack/react-query"
import { Archive, Check, CircleX, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ComingSoon } from "@/components/app/coming-soon"
import { PreviewNote } from "@/components/app/preview-note"
import { QueryFallback } from "@/components/app/query-fallback"
import { errorMessage, keys, useApiMode, useBackupMetadata, useBackups } from "@/hooks/use-hermes"
import { getApi, type Backup } from "@/lib/api"
import { formatDateTime } from "@/lib/format"
import { useT } from "@/lib/i18n"
import { useLang } from "@/lib/prefs"
import { useInstanceId } from "../instance-frame"

const KIND: Record<Backup["kind"], string> = { scheduled: "Scheduled", manual: "Manual", "pre-upgrade": "Before upgrade" }

export default function BackupsPage() {
  const id = useInstanceId()
  const customer = useApiMode() === "customer"
  return customer ? <BackupRecovery id={id} /> : <PreviewBackups id={id} />
}

function BackupRecovery({ id }: { id: string }) {
  const t = useT()
  const lang = useLang()
  const metadata = useBackupMetadata(id)
  const data = metadata.data
  const verification = data?.verification
  const format = new Intl.DateTimeFormat(lang === "id" ? "id-ID" : "en-GB", { dateStyle: "medium", timeStyle: "short" })
  const time = (iso: string) => format.format(new Date(iso))
  const snapshotFallback = data?.observedAt ? t("No snapshot recorded") : t("Status unavailable")
  const verificationLabel = !verification
    ? t("No verification recorded")
    : verification.status === "passed" ? t("Verification passed") : t("Verification failed")

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Backup & Recovery")}</CardTitle>
        <CardDescription>{t("For a restore, contact support with the instance name and the date you need.")}</CardDescription>
        <CardAction>
          <Button asChild size="sm" variant="outline">
            <Link href="/support">{t("Support")}</Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {data === undefined ? (
          <QueryFallback what="Backups" queries={[metadata]} className="h-24" />
        ) : (
          <dl className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1">
              <dt className="text-muted-foreground">{t("Latest snapshot")}</dt>
              <dd>
                {data?.snapshotAt ? <time dateTime={data.snapshotAt}>{time(data.snapshotAt)}</time> : snapshotFallback}
              </dd>
              {data?.observedAt && (
                <dd className="text-muted-foreground">{t("Inventory updated {date}", { date: time(data.observedAt) })}</dd>
              )}
            </div>
            <div className="space-y-1">
              <dt className="text-muted-foreground">{t("Latest verification")}</dt>
              <dd>{verificationLabel}</dd>
              {verification && (
                <dd className="text-muted-foreground">
                  <p>{t("Checked {date}", { date: time(verification.checkedAt) })}</p>
                  <p>{t("Snapshot from {date}", { date: time(verification.snapshotAt) })}</p>
                </dd>
              )}
            </div>
            <div className="space-y-1">
              <dt className="text-muted-foreground">{t("Retention")}</dt>
              <dd>{data?.retentionDays ? t("{days} days", { days: data.retentionDays }) : t("Status unavailable")}</dd>
              {data?.retentionDays && (
                <dd className="text-muted-foreground">{t("The latest snapshot is kept while the instance exists.")}</dd>
              )}
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  )
}

function PreviewBackups({ id }: { id: string }) {
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
        <CardDescription>Planned: encrypted copies of your volume, stored outside the runtime node.</CardDescription>
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

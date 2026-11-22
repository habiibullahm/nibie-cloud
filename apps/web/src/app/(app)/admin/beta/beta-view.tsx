"use client"

import { useState } from "react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PageHeader } from "@/components/app/page-header"
import { useActionConfirmation } from "@/components/app/action-confirmation"
import { AdminTable, TableCell, TableHead, TableRow } from "@/components/app/admin-table"
import { useAddBetaInvite, useAdminBetaInvites, useRevokeBetaInvite } from "@/hooks/use-admin"
import { formatDateTimeId } from "@/lib/admin-format"
import { MIN_REASON, addInviteProblem, inviteErrorMessage, inviteStatusLabel } from "@/lib/admin-beta"
import type { AdminBetaInvite } from "@/lib/api/admin-types"

export function AdminBetaView() {
  const confirm = useActionConfirmation()
  const invites = useAdminBetaInvites()
  const add = useAddBetaInvite()
  const revoke = useRevokeBetaInvite()
  const data = invites.data

  const [email, setEmail] = useState("")
  const [note, setNote] = useState("")
  const [reason, setReason] = useState("")
  const [formError, setFormError] = useState<string | null>(null)

  const [target, setTarget] = useState<AdminBetaInvite | null>(null)
  const [revokeReason, setRevokeReason] = useState("")
  const [revokeError, setRevokeError] = useState<string | null>(null)

  function submitAdd(e: React.FormEvent) {
    e.preventDefault()
    if (add.isPending) return
    const problem = addInviteProblem({ email, reason })
    setFormError(problem)
    if (problem) return
    confirm({
      title: "Kirim undangan beta?",
      description: `${email.trim()} akan mendapat akses beta dan undangan lewat email.`,
      label: "Kirim undangan",
      run: () => add.mutate(
        { email: email.trim(), ...(note.trim() ? { note: note.trim() } : {}), reason: reason.trim() },
        {
          onSuccess: (invite) => {
            if (invite.emailSent) toast.success(`${invite.email} sekarang diundang. Email undangan terkirim.`)
            else toast.warning(`${invite.email} sekarang diundang, tapi email undangan tidak terkirim. Kabari orangnya lewat jalur lain.`)
            setEmail("")
            setNote("")
            setReason("")
          },
          onError: (err) => setFormError(inviteErrorMessage(err)),
        }
      ),
    })
  }

  function submitRevoke() {
    if (!target) return
    if (revokeReason.trim().length < MIN_REASON) {
      setRevokeError(`Alasan minimal ${MIN_REASON} karakter.`)
      return
    }
    revoke.mutate(
      { id: target.id, reason: revokeReason.trim() },
      {
        onSuccess: () => {
          toast.success(`Undangan ${target.email} dicabut.`)
          closeRevoke()
        },
        onError: (err) => setRevokeError(inviteErrorMessage(err)),
      }
    )
  }

  function closeRevoke() {
    setTarget(null)
    setRevokeReason("")
    setRevokeError(null)
  }

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Undangan beta"
        description="Akun yang boleh membuat instance walau slot beta gratis tidak dibuka. Undangan di sini berlaku langsung, tanpa restart backend. Perubahan tercatat di Audit bersama alasannya."
      />

      {data && data.freeBetaSlots === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Beta gratis hanya lewat undangan</CardTitle>
            <CardDescription>
              FREE_BETA_SLOTS di backend bernilai 0, jadi hanya email yang diundang yang bisa membuat instance.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Tambah undangan</CardTitle>
          <CardDescription>
            Orangnya tetap harus mendaftar dan mengonfirmasi email yang sama di dashboard.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submitAdd} className="grid gap-4 sm:max-w-xl" noValidate>
            <div className="grid gap-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={formError !== null && !email.trim() ? true : undefined}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="invite-note">Catatan (opsional)</Label>
              <Input id="invite-note" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="invite-reason">Alasan</Label>
              <Input id="invite-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            {formError ? (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}
            <div>
              <Button type="submit" disabled={add.isPending}>
                {add.isPending ? "Menyimpan…" : "Tambah undangan"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {data ? (
        <Card>
          <CardHeader>
            <CardTitle>Dari server</CardTitle>
            <CardDescription>
              Daftar BETA_ALLOWED_EMAILS di host ({data.fromEnv.length}). Hanya bisa diubah di file env server, lalu backend dibuat ulang.
            </CardDescription>
          </CardHeader>
          {data.fromEnv.length > 0 ? (
            <CardContent>
              <ul className="grid gap-1">
                {data.fromEnv.map((e) => (
                  <li key={e} className="type-mono">
                    {e}
                  </li>
                ))}
              </ul>
            </CardContent>
          ) : null}
        </Card>
      ) : null}

      <AdminTable
        what="undangan beta"
        rows={data?.invites ?? []}
        queries={[invites]}
        empty="Belum ada undangan di database."
        caption="Undangan beta di database, terbaru dulu"
        head={
          <>
            <TableHead scope="col">Email</TableHead>
            <TableHead scope="col">Catatan</TableHead>
            <TableHead scope="col">Ditambah oleh</TableHead>
            <TableHead scope="col">Ditambah</TableHead>
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col">
              <span className="sr-only">Aksi</span>
            </TableHead>
          </>
        }
        row={(i) => (
          <TableRow key={i.id}>
            <TableCell className="type-mono">{i.email}</TableCell>
            <TableCell className="max-w-xs whitespace-normal break-words text-muted-foreground">{i.note ?? "-"}</TableCell>
            <TableCell className="type-mono">{i.addedBy ?? "-"}</TableCell>
            <TableCell className="type-mono">{formatDateTimeId(i.createdAt)}</TableCell>
            <TableCell className="type-label">
              {inviteStatusLabel(i)}
              {i.revokedAt ? ` · ${formatDateTimeId(i.revokedAt)}` : ""}
            </TableCell>
            <TableCell>
              {i.revokedAt ? null : (
                <Button type="button" variant="outline" size="xs" onClick={() => setTarget(i)}>
                  Cabut
                  <span className="sr-only"> undangan {i.email}</span>
                </Button>
              )}
            </TableCell>
          </TableRow>
        )}
      />

      <AlertDialog open={target !== null} onOpenChange={(o) => !o && closeRevoke()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cabut undangan?</AlertDialogTitle>
            <AlertDialogDescription>
              {target?.email} tidak bisa membuat instance baru lagi. Instance yang sudah ada tetap berjalan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="revoke-reason">Alasan</Label>
            <Input id="revoke-reason" maxLength={500} value={revokeReason} onChange={(e) => setRevokeReason(e.target.value)} />
            {revokeError ? (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{revokeError}</AlertDescription>
              </Alert>
            ) : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <Button type="button" variant="destructive" disabled={revoke.isPending} onClick={submitRevoke}>
              {revoke.isPending ? "Mencabut…" : "Cabut undangan"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

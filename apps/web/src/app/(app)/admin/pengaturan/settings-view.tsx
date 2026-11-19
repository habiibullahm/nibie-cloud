"use client"

import Link from "next/link"
import { useState } from "react"
import { toast } from "sonner"
import { Copy } from "lucide-react"
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { AdminTable, TableCell, TableHead, TableRow } from "@/components/app/admin-table"
import { KeyValue } from "@/components/app/key-value"
import { PageHeader } from "@/components/app/page-header"
import { QueryFallback } from "@/components/app/query-fallback"
import { useAdminApiKeys, useAdminSystem, useCreateApiKey, useRevokeApiKey, useSetSupportContact } from "@/hooks/use-admin"
import { useSupportContact } from "@/hooks/use-hermes"
import { formatDateTimeId } from "@/lib/admin-format"
import { MIN_REASON } from "@/lib/admin-beta"
import {
  KEY_EXPIRY_OPTIONS,
  claudeMcpCommand,
  createKeyProblem,
  expiryDays,
  keyErrorMessage,
  keyStatusLabel,
  mcpUrl,
  onOff,
} from "@/lib/admin-settings"
import type { AdminApiKey, AdminSettings } from "@/lib/api/admin-types"
import { copyWithToast } from "@/lib/copy"

const mono = (v: string) => <span className="type-mono">{v}</span>

function SettingsCards({ s }: { s: AdminSettings }) {
  const b = s.billing
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Penagihan</CardTitle>
          <CardDescription>Gateway pembayaran. Harga plan ada di halaman <Link className="underline" href="/admin/plan">Plan</Link>.</CardDescription>
        </CardHeader>
        <CardContent>
          <KeyValue
            items={[
              { k: "Gateway", v: b.gateway ? mono(b.gateway) : "Mati" },
              { k: "Checkout berbayar", v: b.paidCheckoutOpen ? "Terbuka untuk semua" : "Hanya akun undangan" },
              { k: "SumoPod", v: b.sumopod ? `${b.sumopod.env} · webhook ${b.sumopod.webhookSigned ? "bertanda tangan (Svix)" : "token saja"}` : "Tidak diatur" },
              { k: "Duitku", v: b.duitku ? b.duitku.env : "Tidak diatur" },
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Email</CardTitle>
          <CardDescription>Email keluar lewat SMTP SumoPod.</CardDescription>
        </CardHeader>
        <CardContent>
          <KeyValue
            items={[
              { k: "SMTP", v: onOff(s.email.configured) },
              { k: "Pengirim", v: s.email.from ? mono(s.email.from) : "-" },
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Masuk & beta</CardTitle>
          <CardDescription>Undangan di database diatur di <Link className="underline" href="/admin/beta">Undangan beta</Link>.</CardDescription>
        </CardHeader>
        <CardContent>
          <KeyValue
            items={[
              { k: "Supabase Auth", v: onOff(s.signIn.supabase) },
              { k: "Email admin", v: `${s.signIn.adminEmails}` },
              { k: "Undangan dari env", v: `${s.signIn.betaAllowedEmails} email` },
              { k: "Slot beta gratis", v: s.signIn.freeBetaSlots === 0 ? "0 (hanya undangan)" : `${s.signIn.freeBetaSlots}` },
              { k: "Captcha Turnstile", v: onOff(s.signIn.turnstile) },
              { k: "Instance per akun", v: `${s.signIn.maxInstancesPerTenant}` },
              { k: "Batas instance server", v: s.signIn.maxTotalInstances === null ? "Tanpa batas" : `${s.signIn.maxTotalInstances}` },
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI / NibieRouter</CardTitle>
          <CardDescription>Kunci dan kredit router per instance. Kredit per plan ada di halaman Plan.</CardDescription>
        </CardHeader>
        <CardContent>
          <KeyValue
            items={[
              { k: "Provisioning", v: onOff(s.ai.configured) },
              { k: "Model default", v: s.ai.defaultModel ? mono(s.ai.defaultModel) : "-" },
              { k: "Domain email user", v: s.ai.userEmailDomain ? mono(s.ai.userEmailDomain) : "-" },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  )
}

function ApiKeys({ mcpPath }: { mcpPath: string }) {
  const keys = useAdminApiKeys()
  const create = useCreateApiKey()
  const revoke = useRevokeApiKey()

  const [name, setName] = useState("")
  const [expiry, setExpiry] = useState<string>("90")
  const [reason, setReason] = useState("")
  const [formError, setFormError] = useState<string | null>(null)
  // Held only until the dialog closes; never stored anywhere else.
  const [created, setCreated] = useState<string | null>(null)

  const [target, setTarget] = useState<AdminApiKey | null>(null)
  const [revokeReason, setRevokeReason] = useState("")
  const [revokeError, setRevokeError] = useState<string | null>(null)

  // The mutation result holds the plaintext too, so it is dropped with the dialog.
  function closeCreated() {
    setCreated(null)
    create.reset()
  }

  const url = mcpUrl(process.env.NEXT_PUBLIC_HERMES_API_URL ?? "", mcpPath)
  const command = claudeMcpCommand(url)

  function submitCreate(e: React.FormEvent) {
    e.preventDefault()
    const problem = createKeyProblem({ name, reason }, MIN_REASON)
    setFormError(problem)
    if (problem) return
    create.mutate(
      { name: name.trim(), expiresInDays: expiryDays(expiry), reason: reason.trim() },
      {
        onSuccess: (r) => {
          setCreated(r.plaintext)
          setName("")
          setReason("")
        },
        onError: (err) => setFormError(keyErrorMessage(err)),
      }
    )
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
          toast.success(`Kunci ${target.name} dicabut.`)
          closeRevoke()
        },
        onError: (err) => setRevokeError(keyErrorMessage(err)),
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
      <Card>
        <CardHeader>
          <CardTitle>Kunci admin & MCP</CardTitle>
          <CardDescription>
            Kunci admin membuka semua yang ada di panel ini tanpa verifikasi 2 langkah, untuk Claude Code lewat MCP atau skrip.
            Simpan seperti kata sandi. Kunci berhenti berlaku bila dicabut, kedaluwarsa, atau pembuatnya dihapus dari ADMIN_EMAILS.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="mcp-url">URL MCP</Label>
            <div className="flex gap-2">
              <Input id="mcp-url" readOnly value={url} className="type-mono" />
              <Button type="button" variant="outline" onClick={() => copyWithToast(url, "MCP URL")}>
                <Copy aria-hidden="true" />
                <span className="sr-only">Salin URL MCP</span>
              </Button>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="mcp-command">Perintah Claude Code (ganti &lt;KUNCI&gt; dengan kunci Anda)</Label>
            <div className="flex gap-2">
              <Input id="mcp-command" readOnly value={command} className="type-mono" />
              <Button type="button" variant="outline" onClick={() => copyWithToast(command, "command")}>
                <Copy aria-hidden="true" />
                <span className="sr-only">Salin perintah</span>
              </Button>
            </div>
          </div>

          <form onSubmit={submitCreate} className="grid gap-4 border-t pt-4 sm:max-w-xl" noValidate>
            <div className="grid gap-2">
              <Label htmlFor="key-name">Nama kunci</Label>
              <Input id="key-name" maxLength={100} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="key-expiry">Masa berlaku</Label>
              <Select value={expiry} onValueChange={setExpiry}>
                <SelectTrigger id="key-expiry" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KEY_EXPIRY_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="key-reason">Alasan</Label>
              <Input id="key-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            {formError ? (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}
            <div>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? "Membuat…" : "Buat kunci"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <AdminTable
        what="kunci admin"
        rows={keys.data ?? []}
        queries={[keys]}
        empty="Belum ada kunci admin."
        caption="Kunci admin, terbaru dulu"
        head={
          <>
            <TableHead scope="col">Nama</TableHead>
            <TableHead scope="col">Awalan</TableHead>
            <TableHead scope="col">Dibuat oleh</TableHead>
            <TableHead scope="col">Dibuat</TableHead>
            <TableHead scope="col">Berlaku sampai</TableHead>
            <TableHead scope="col">Terakhir dipakai</TableHead>
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col">
              <span className="sr-only">Aksi</span>
            </TableHead>
          </>
        }
        row={(k) => (
          <TableRow key={k.id}>
            <TableCell>{k.name}</TableCell>
            <TableCell className="type-mono">{k.prefix}…</TableCell>
            <TableCell className="type-mono">{k.createdByEmail}</TableCell>
            <TableCell className="type-mono">{formatDateTimeId(k.createdAt)}</TableCell>
            <TableCell className="type-mono">{k.expiresAt ? formatDateTimeId(k.expiresAt) : "Tanpa batas"}</TableCell>
            <TableCell className="type-mono">{formatDateTimeId(k.lastUsedAt)}</TableCell>
            <TableCell className="type-label">{keyStatusLabel(k)}</TableCell>
            <TableCell>
              {k.revokedAt ? null : (
                <Button type="button" variant="outline" size="xs" onClick={() => setTarget(k)}>
                  Cabut
                  <span className="sr-only"> kunci {k.name}</span>
                </Button>
              )}
            </TableCell>
          </TableRow>
        )}
      />

      <Dialog open={created !== null} onOpenChange={(o) => !o && closeCreated()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Kunci admin baru</DialogTitle>
            <DialogDescription>
              Salin sekarang. Kunci ini tidak akan ditampilkan lagi; yang disimpan hanya hash-nya.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Label htmlFor="new-key" className="sr-only">Kunci admin</Label>
            <Input id="new-key" readOnly value={created ?? ""} className="type-mono" onFocus={(e) => e.currentTarget.select()} />
            <Button type="button" variant="outline" onClick={() => created && copyWithToast(created, "admin key")}>
              <Copy aria-hidden="true" />
              <span className="sr-only">Salin kunci</span>
            </Button>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={closeCreated}>
              Sudah saya simpan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={target !== null} onOpenChange={(o) => !o && closeRevoke()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cabut kunci?</AlertDialogTitle>
            <AlertDialogDescription>
              {target?.name} ({target?.prefix}…) langsung berhenti berlaku. Klien MCP atau skrip yang memakainya akan ditolak.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="key-revoke-reason">Alasan</Label>
            <Input id="key-revoke-reason" maxLength={500} value={revokeReason} onChange={(e) => setRevokeReason(e.target.value)} />
            {revokeError ? (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{revokeError}</AlertDescription>
              </Alert>
            ) : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <Button type="button" variant="destructive" disabled={revoke.isPending} onClick={submitRevoke}>
              {revoke.isPending ? "Mencabut…" : "Cabut kunci"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** The contacts on the customer Support page and footer. Saved in the database, so a change shows without a rebuild. */
function SupportContactCard() {
  const contact = useSupportContact()
  return (
    <Card>
      <CardHeader>
        <CardTitle>Kontak bantuan</CardTitle>
        <CardDescription>Tampil di halaman Bantuan dashboard. Kosongkan untuk menyembunyikan.</CardDescription>
      </CardHeader>
      <CardContent>
        {contact.data ? (
          <SupportContactForm whatsapp={contact.data.whatsapp ?? ""} email={contact.data.email ?? ""} groupUrl={contact.data.groupUrl ?? ""} />
        ) : (
          <QueryFallback what="kontak bantuan" queries={[contact]} className="h-24 bg-elevated" />
        )}
      </CardContent>
    </Card>
  )
}

function SupportContactForm(initial: { whatsapp: string; email: string; groupUrl: string }) {
  const save = useSetSupportContact()
  const [whatsapp, setWhatsapp] = useState(initial.whatsapp)
  const [email, setEmail] = useState(initial.email)
  const [groupUrl, setGroupUrl] = useState(initial.groupUrl)
  const [error, setError] = useState<string | null>(null)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    save.mutate(
      { whatsapp: whatsapp.trim(), email: email.trim(), groupUrl: groupUrl.trim() },
      {
        onSuccess: (saved) => {
          setWhatsapp(saved.whatsapp ?? "")
          setEmail(saved.email ?? "")
          setGroupUrl(saved.groupUrl ?? "")
          toast.success("Kontak bantuan disimpan.")
        },
        // The backend answers only "Invalid request" for a bad body, so say here what it checks.
        onError: (err) =>
          setError(
            (err as { code?: string }).code === "validation_error"
              ? "Nomor WhatsApp pakai kode negara (contoh 6281234567890), email harus valid, link grup berbentuk https://chat.whatsapp.com/kode."
              : err instanceof Error
                ? err.message
                : "Gagal menyimpan."
          ),
      }
    )
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="support-wa">WhatsApp</Label>
          <Input
            id="support-wa"
            inputMode="tel"
            autoComplete="off"
            maxLength={25}
            placeholder="6281234567890"
            value={whatsapp}
            onChange={(e) => setWhatsapp(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="support-email">Email</Label>
          <Input id="support-email" type="email" autoComplete="off" maxLength={254} placeholder="support@nibie.app" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="grid gap-2 sm:col-span-2">
          <Label htmlFor="support-group">Grup WhatsApp</Label>
          <Input
            id="support-group"
            inputMode="url"
            autoComplete="off"
            maxLength={200}
            placeholder="https://chat.whatsapp.com/…"
            value={groupUrl}
            onChange={(e) => setGroupUrl(e.target.value)}
          />
        </div>
      </div>
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Menyimpan…" : "Simpan"}
        </Button>
      </div>
    </form>
  )
}

export function AdminSettingsView() {
  const system = useAdminSystem()

  return (
    <div className="grid gap-8">
      <PageHeader
        title="Pengaturan"
        description="Kontak bantuan bisa diubah di sini. Sisanya dibaca dari konfigurasi server (.env): ubah di file env server, lalu buat ulang backend. Nilai rahasia tidak pernah ditampilkan."
      />
      <SupportContactCard />
      {system.isPending || system.error ? (
        <QueryFallback what="pengaturan" queries={[system]} />
      ) : (
        <>
          <SettingsCards s={system.data.settings} />
          <ApiKeys mcpPath={system.data.settings.mcpPath} />
        </>
      )}
    </div>
  )
}

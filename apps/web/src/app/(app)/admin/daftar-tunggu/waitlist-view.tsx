"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PageHeader } from "@/components/app/page-header"
import { AdminTable, TableCell, TableHead, TableRow } from "@/components/app/admin-table"
import { useAdminWaitlist } from "@/hooks/use-admin"
import { formatDateTimeId } from "@/lib/admin-format"
import { waitlistStatusLabel } from "@/lib/admin-waitlist"

export function AdminWaitlistView() {
  const waitlist = useAdminWaitlist()
  const data = waitlist.data
  const entries = data?.entries ?? []

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Daftar tunggu"
        description="Antrean beta gratis. Sistem mengundang orang paling lama menunggu lewat email saat ada slot kosong; halaman ini hanya untuk dilihat."
      />

      {data ? (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {(
            [
              ["Belum konfirmasi", data.counts.unconfirmed],
              ["Menunggu", data.counts.waiting],
              ["Diundang", data.counts.invited],
              ["Kedaluwarsa", data.counts.lapsed],
              ["Sudah daftar", data.counts.registered],
            ] as const
          ).map(([label, n]) => (
            <div key={label} className="rounded-sm border px-4 py-3">
              <dt className="type-label text-muted-foreground">{label}</dt>
              <dd className="type-mono">{n}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {data && data.freeBetaSlots === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Beta gratis belum aktif</CardTitle>
            <CardDescription>FREE_BETA_SLOTS di backend bernilai 0, jadi tidak ada undangan yang dikirim.</CardDescription>
          </CardHeader>
          <CardContent />
        </Card>
      ) : null}

      <AdminTable
        what="daftar tunggu"
        rows={entries}
        queries={[waitlist]}
        empty="Belum ada yang masuk daftar tunggu."
        caption="Daftar tunggu, urut dari yang paling lama"
        head={
          <>
            <TableHead scope="col">#</TableHead>
            <TableHead scope="col">Nama</TableHead>
            <TableHead scope="col">Email</TableHead>
            <TableHead scope="col">Kegunaan</TableHead>
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col">Masuk</TableHead>
            <TableHead scope="col">Batas klaim</TableHead>
          </>
        }
        row={(e, i) => (
          <TableRow key={e.id}>
            <TableCell className="type-mono">{i + 1}</TableCell>
            <TableCell>{e.name}</TableCell>
            <TableCell className="type-mono">{e.email}</TableCell>
            <TableCell className="max-w-xs whitespace-normal break-words text-muted-foreground">{e.useCase}</TableCell>
            <TableCell className="type-label">
              {waitlistStatusLabel(e)}
              {e.inviteFailures > 0 ? ` · gagal kirim ${e.inviteFailures}x` : ""}
            </TableCell>
            <TableCell className="type-mono">{formatDateTimeId(e.createdAt)}</TableCell>
            <TableCell className="type-mono">{formatDateTimeId(e.inviteExpiresAt)}</TableCell>
          </TableRow>
        )}
      />
    </div>
  )
}

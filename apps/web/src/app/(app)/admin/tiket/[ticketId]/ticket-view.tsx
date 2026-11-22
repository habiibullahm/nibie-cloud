"use client"

import Link from "next/link"
import { useState } from "react"
import { ArrowLeft } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { PageHeader } from "@/components/app/page-header"
import { useActionConfirmation } from "@/components/app/action-confirmation"
import { QueryFallback } from "@/components/app/query-fallback"
import { TicketReply, TicketStatusChip, TicketThread } from "@/components/app/ticket-thread"
import { useAdminTicket, useAdminTicketAction } from "@/hooks/use-admin"
import { formatDateTimeId } from "@/lib/admin-format"
import { ADMIN_CATEGORY, ADMIN_STATUS } from "@/lib/ticket-labels"

export function AdminTicketView({ ticketId }: { ticketId: string }) {
  const confirm = useActionConfirmation()
  const ticket = useAdminTicket(ticketId)
  const action = useAdminTicketAction(ticketId)
  const [error, setError] = useState<string | null>(null)
  const k = ticket.data
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : "Gagal menyimpan.")

  return (
    <div className="grid max-w-3xl gap-6">
      <Link href="/admin/tiket" className="inline-flex w-fit items-center gap-2 text-muted-foreground no-underline hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Semua tiket
      </Link>

      {!k ? (
        <QueryFallback what="tiket" queries={[ticket]} />
      ) : (
        <>
          <PageHeader
            title={k.subject}
            description={`${k.createdByEmail} · ${ADMIN_CATEGORY[k.category]}${k.instance ? ` · ${k.instance.name}` : ""}`}
            actions={<TicketStatusChip closed={k.status === "CLOSED"}>{ADMIN_STATUS[k.status]}</TicketStatusChip>}
          />
          {k.instance ? (
            <Link href={`/admin/instance/${k.instance.id}`} className="w-fit underline decoration-input underline-offset-4 hover:decoration-foreground">
              Lihat instance {k.instance.name}
            </Link>
          ) : null}
          <TicketThread
            messages={k.messages}
            authorLabel={(m) => (m.author === "ADMIN" ? "Tim Nibie Cloud" : k.createdByEmail)}
            formatTime={(iso) => formatDateTimeId(iso)}
          />
          <TicketReply
            label="Balasan"
            sendLabel="Kirim balasan"
            sendingLabel="Mengirim…"
            pending={action.reply.isPending}
            error={error}
            onSend={(message, done) => confirm({
              title: "Kirim balasan?",
              description: "Balasan akan tampil di tiket dan dikirim lewat email ke pelanggan.",
              label: "Kirim balasan",
              run: () => {
                setError(null)
                action.reply.mutate(message, {
                  onSuccess: () => {
                    done()
                    toast.success("Balasan terkirim. Pelanggan juga menerima email.")
                  },
                  onError: fail,
                })
              },
            })}
          />
          {k.status !== "CLOSED" ? (
            <div className="border-t pt-4">
              <Button type="button" variant="outline" disabled={action.close.isPending} onClick={() => confirm({
                title: "Tandai tiket selesai?",
                description: "Tiket akan ditutup. Pelanggan bisa membukanya kembali dengan membalas.",
                label: "Tandai selesai",
                run: () => action.close.mutate(undefined, { onError: fail }),
              })}>
                Tandai selesai
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

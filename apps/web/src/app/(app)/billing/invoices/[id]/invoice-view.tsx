"use client"

import Link from "next/link"
import { useParams } from "next/navigation"
import { useEffect } from "react"
import { ArrowLeft, CircleCheck, Printer } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { QueryFallback } from "@/components/app/query-fallback"
import { useInvoice } from "@/hooks/use-hermes"
import { formatDate, formatPriceIdr } from "@/lib/format"
import { useT } from "@/lib/i18n"
import { invoiceItem, SELLER } from "@/lib/invoice"
import { useLang } from "@/lib/prefs"

/** Paper is light: print with the light palette whatever theme is on screen, then put the viewer's theme back. */
function usePrintInLight() {
  useEffect(() => {
    const root = document.documentElement
    // undefined: not printing. Remembered once, so a repeated beforeprint cannot overwrite the viewer's theme.
    let previous: string | null | undefined
    const before = () => {
      if (previous !== undefined) return
      previous = root.getAttribute("data-theme")
      root.setAttribute("data-theme", "light")
    }
    const after = () => {
      if (previous === undefined) return
      if (previous === null) root.removeAttribute("data-theme")
      else root.setAttribute("data-theme", previous)
      previous = undefined
    }
    window.addEventListener("beforeprint", before)
    window.addEventListener("afterprint", after)
    return () => {
      window.removeEventListener("beforeprint", before)
      window.removeEventListener("afterprint", after)
    }
  }, [])
}

export function InvoiceView() {
  const t = useT()
  const lang = useLang()
  const { id } = useParams<{ id: string }>()
  const invoice = useInvoice(id)
  usePrintInLight()
  const inv = invoice.data

  return (
    <div className="grid max-w-3xl gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href="/billing" className="inline-flex w-fit items-center gap-2 text-muted-foreground no-underline hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t("Billing")}
        </Link>
        {inv ? (
          <Button variant="outline" onClick={() => window.print()}>
            <Printer aria-hidden="true" />
            {t("Print or save as PDF")}
          </Button>
        ) : null}
      </div>

      {!inv ? (
        <QueryFallback what="invoice" queries={[invoice]} />
      ) : (
        <Card className="print:border-0 print:shadow-none">
          <CardContent className="grid gap-8 p-6 sm:p-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="font-medium">{SELLER.name}</p>
                <p className="text-muted-foreground">{SELLER.operator}</p>
              </div>
              <div className="grid justify-items-start gap-2 sm:justify-items-end">
                <h1 className="type-h1">{t("Invoice")}</h1>
                <p className="type-mono">{inv.number}</p>
                <Badge variant="outline">
                  <CircleCheck aria-hidden="true" />
                  {t("Paid")}
                </Badge>
              </div>
            </div>

            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="type-label text-muted-foreground">{t("Billed to")}</dt>
                <dd className="break-all">{inv.billedTo ?? "—"}</dd>
              </div>
              <div>
                <dt className="type-label text-muted-foreground">{t("Paid on")}</dt>
                <dd>{formatDate(inv.paidAt, lang)}</dd>
              </div>
              <div>
                <dt className="type-label text-muted-foreground">{t("Payment method")}</dt>
                <dd>QRIS (SumoPod)</dd>
              </div>
              {inv.reference ? (
                <div>
                  <dt className="type-label text-muted-foreground">{t("Payment reference")}</dt>
                  <dd className="type-mono break-all">{inv.reference}</dd>
                </div>
              ) : null}
            </dl>

            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Description")}</TableHead>
                    <TableHead className="text-right">{t("Amount")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell className="whitespace-normal">{invoiceItem(inv, t)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatPriceIdr(inv.amountIdr, lang)}</TableCell>
                  </TableRow>
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell className="font-medium">{t("Total paid")}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{formatPriceIdr(inv.amountIdr, lang)}</TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </div>

            {inv.kind === "TOPUP" ? (
              <p className="text-muted-foreground">{t("Nibie Cloud balance is not cash and cannot be refunded or withdrawn.")}</p>
            ) : null}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

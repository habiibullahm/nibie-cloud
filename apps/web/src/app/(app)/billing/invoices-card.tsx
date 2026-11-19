"use client"

import Link from "next/link"
import { FileText } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { QueryFallback } from "@/components/app/query-fallback"
import { useInvoices } from "@/hooks/use-hermes"
import { formatDate, formatPriceIdr } from "@/lib/format"
import { useT } from "@/lib/i18n"
import { invoiceItem } from "@/lib/invoice"
import { useLang } from "@/lib/prefs"

/** Every paid hosting payment and top-up, each with its own invoice page. */
export function InvoicesCard() {
  const t = useT()
  const lang = useLang()
  const invoices = useInvoices()
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="size-4" aria-hidden="true" />
          {t("Invoices")}
        </CardTitle>
        <CardDescription>{t("One invoice for every payment. Open one to print it or save it as a PDF.")}</CardDescription>
      </CardHeader>
      <CardContent>
        {!invoices.data ? (
          <QueryFallback what="your invoices" queries={[invoices]} className="h-24" />
        ) : invoices.data.length === 0 ? (
          <p className="text-muted-foreground">{t("No invoices yet.")}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Number")}</TableHead>
                  <TableHead>{t("Date")}</TableHead>
                  <TableHead>{t("Description")}</TableHead>
                  <TableHead className="text-right">{t("Amount")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.data.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell className="type-mono">
                      <Link href={`/billing/invoices/${inv.id}`}>{inv.number}</Link>
                    </TableCell>
                    <TableCell>{formatDate(inv.paidAt, lang)}</TableCell>
                    <TableCell className="whitespace-normal">{invoiceItem(inv, t)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatPriceIdr(inv.amountIdr, lang)}</TableCell>
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

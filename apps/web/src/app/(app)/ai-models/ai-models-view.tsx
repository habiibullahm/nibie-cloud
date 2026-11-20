"use client"

import Link from "next/link"
import { Bot, Copy } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState } from "@/components/app/empty-state"
import { PageHeader } from "@/components/app/page-header"
import { PreviewNote } from "@/components/app/preview-note"
import { QueryFallback } from "@/components/app/query-fallback"
import { useAiModels, useApiMode } from "@/hooks/use-hermes"
import { copyWithToast } from "@/lib/copy"
import { useT } from "@/lib/i18n"

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 })

/** The NibieRouter models this account may call with its API keys, with prices per 1 million tokens. */
export function AiModelsView() {
  const t = useT()
  const mock = useApiMode() === "mock"
  const query = useAiModels()
  const data = query.data

  return (
    <div className="grid gap-6">
      <PageHeader
        title={t("AI models")}
        description={t("The NibieRouter models you can call with your API keys. Prices are in US$ per 1 million tokens.")}
        actions={mock ? <PreviewNote what="AI models" reason="mock" /> : null}
      />

      {data === undefined ? (
        <QueryFallback what="the AI models" queries={[query]} className="h-48" />
      ) : data === null ? (
        <EmptyState
          icon={<Bot aria-hidden="true" />}
          title={t("AI models are not available")}
          description={t("NibieRouter is not set up on this server.")}
        />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t("Base URL")}</CardTitle>
              <CardDescription>
                {t("OpenAI-compatible: send the model name with a key from")}{" "}
                <Link href="/api-keys" className="text-foreground underline underline-offset-4">
                  {t("API keys")}
                </Link>
                . {t("Paid models are paid from your AI balance.")}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2">
              <Label htmlFor="ai-models-base-url" className="sr-only">
                {t("Base URL")}
              </Label>
              <div className="flex gap-2">
                <Input id="ai-models-base-url" readOnly value={data.baseUrl} className="type-mono" />
                <Button type="button" variant="outline" onClick={() => copyWithToast(data.baseUrl, "Base URL")}>
                  <Copy aria-hidden="true" />
                  <span className="sr-only">{t("Copy base URL")}</span>
                </Button>
              </div>
            </CardContent>
          </Card>

          {data.freeOnly ? (
            <p className="text-muted-foreground">{t("Your plan includes the free models. Paid models come with a paid plan.")}</p>
          ) : null}

          {data.models.length === 0 ? (
            <EmptyState icon={<Bot aria-hidden="true" />} title={t("No models right now")} description={t("Try again in a few minutes.")} />
          ) : (
            <Table>
              <caption className="sr-only">{t("AI models")}</caption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t("Model")}</TableHead>
                  <TableHead scope="col" className="text-right">
                    {t("Input / 1M tokens")}
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    {t("Output / 1M tokens")}
                  </TableHead>
                  <TableHead scope="col">{t("Price")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.models.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>
                      <div className="grid gap-1">
                        <span className="type-label">{m.name}</span>
                        <span className="inline-flex items-center gap-1">
                          <span className="type-mono break-all text-muted-foreground">{m.id}</span>
                          <Button type="button" variant="ghost" size="icon-xs" onClick={() => copyWithToast(m.id, "Model name")}>
                            <Copy aria-hidden="true" />
                            <span className="sr-only">{t("Copy model name {id}", { id: m.id })}</span>
                          </Button>
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="type-mono text-right tabular-nums">{usd(m.promptUsdPerM)}</TableCell>
                    <TableCell className="type-mono text-right tabular-nums">{usd(m.completionUsdPerM)}</TableCell>
                    <TableCell>
                      <Badge variant={m.free ? "default" : "outline"}>{m.free ? t("Free") : t("Pay per use")}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
    </div>
  )
}

"use client"

import Link from "next/link"
import { Info } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import type { Plan } from "@/lib/api"
import { formatPriceIdr } from "@/lib/format"
import { useT } from "@/lib/i18n"
import { useLang } from "@/lib/prefs"

/**
 * Shown on the overview of a free instance when the Kredit plan is available, explaining why free models can
 * feel slow and pointing to the instance's billing page.
 */
export function FreeUpsell({
  instanceId,
  planId,
  plans,
  className,
}: {
  instanceId: string
  planId: string
  plans?: Plan[]
  className?: string
}) {
  const t = useT()
  const lang = useLang()

  if (!plans) return null
  const current = plans.find((p) => p.id === planId)
  if (!current || current.monthlyPriceIdr !== null) return null

  const kredit = plans.find((p) => p.slug === "hosting-kredit" || p.id === "hosting-kredit")
  if (!kredit || !kredit.available || kredit.monthlyPriceIdr === null || !kredit.includedCreditUsd) return null

  return (
    <Alert className={className} aria-labelledby="free-upsell-title">
      <Info aria-hidden="true" />
      <AlertTitle id="free-upsell-title">{t("Free plan uses free AI models")}</AlertTitle>
      <AlertDescription>
        <p>
          {t(
            "Free models can be slow or limited when busy. {plan} costs {price} per month and includes US${credit} AI credit every month for faster models.",
            {
              plan: kredit.name,
              price: formatPriceIdr(kredit.monthlyPriceIdr, lang),
              credit: kredit.includedCreditUsd,
            }
          )}
        </p>
        <div className="pt-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/instances/${instanceId}/billing`}>{t("See paid plans")}</Link>
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}

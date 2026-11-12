"use client"

import Link from "next/link"
import { Globe } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/app/empty-state"
import { PreviewNote } from "@/components/app/preview-note"
import { useInstance, useInstanceMeta, usePlans } from "@/hooks/use-hermes"
import { useInstanceId } from "../instance-frame"

export default function DomainPage() {
  const id = useInstanceId()
  const { data: instance } = useInstance(id)
  const meta = useInstanceMeta(id)
  const plans = usePlans()
  const plan = plans.data?.find((p) => p.id === meta.data?.planId)

  if (!instance || !plan) return <Skeleton className="h-48 bg-card" />

  if (!plan.customDomain) {
    return (
      <EmptyState
        icon={<Globe />}
        title="Custom domains need a larger plan"
        description={`The ${plan.name} plan uses the instance URL only. Switch to a plan with custom domains to use your own.`}
        action={
          <Button asChild variant="outline">
            <Link href={`/instances/${id}/billing`}>See plans</Link>
          </Button>
        }
      />
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Custom domain</CardTitle>
        <CardDescription>Serve Hermes from a domain you own.</CardDescription>
        <CardAction>
          <PreviewNote what="Custom domains" />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid max-w-md gap-2">
          <Label htmlFor="domain">Domain</Label>
          <Input id="domain" placeholder="agent.example.com" disabled aria-describedby="domain-hint" />
          <p id="domain-hint" className="text-muted-foreground">
            You will add a CNAME record pointing to your instance URL, then we verify it and issue a certificate.
          </p>
        </div>
      </CardContent>
      <CardFooter className="border-t">
        <p className="text-muted-foreground">Custom domains depend on the ingress rollout and are not available yet.</p>
      </CardFooter>
    </Card>
  )
}

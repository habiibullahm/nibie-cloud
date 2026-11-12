"use client"

import { Copy, ExternalLink, KeyRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { PreviewNote } from "@/components/app/preview-note"
import { QueryFallback } from "@/components/app/query-fallback"
import { useAccess, useInstance } from "@/hooks/use-hermes"
import { copyWithToast } from "@/lib/copy"
import { useInstanceId } from "../instance-frame"

export default function AccessPage() {
  const id = useInstanceId()
  const { data: instance } = useInstance(id)
  const access = useAccess(id)
  if (!instance) return <Skeleton className="h-48 bg-card" />
  const url = instance.accessUrl

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Instance URL</CardTitle>
          <CardDescription>Where your Hermes web interface is served.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {url ? (
            <>
              <code className="type-mono block rounded-sm border bg-elevated px-3 py-2 break-all">{url}</code>
              <div className="flex flex-wrap gap-2">
                <Button asChild>
                  <a href={url} target="_blank" rel="noreferrer">
                    <ExternalLink aria-hidden="true" />
                    Open Hermes
                  </a>
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void copyWithToast(url, "URL")}
                >
                  <Copy aria-hidden="true" />
                  Copy URL
                </Button>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground">The URL appears once the instance is active.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How to connect</CardTitle>
          <CardDescription>Access instructions for this instance.</CardDescription>
          <CardAction>
            <PreviewNote what="Access instructions" />
          </CardAction>
        </CardHeader>
        <CardContent>
          {access.data ? (
            <ol className="grid list-decimal gap-2 pl-4">
              {access.data.instructions.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          ) : (
            <QueryFallback what="access instructions" queries={[access]} className="h-20 bg-elevated" />
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Credentials</CardTitle>
          <CardDescription>How secrets for this instance are handled.</CardDescription>
        </CardHeader>
        <CardContent className="flex items-start gap-3">
          <KeyRound className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p className="text-muted-foreground">
            The gateway API key is generated per instance and managed by Hermes Cloud. Provider keys and your Telegram
            token are stored encrypted and redacted from logs.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

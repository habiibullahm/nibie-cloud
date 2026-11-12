"use client"

import { RefreshCw } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage } from "@/hooks/use-hermes"
import { cn } from "@/lib/utils"

type QueryLike = { error: unknown; refetch: () => unknown; isFetching: boolean }

/**
 * What a view shows before its data is ready: an error with a retry when any query failed,
 * otherwise a skeleton that names what is loading (antislop R-27).
 */
export function QueryFallback({ what, queries, className }: { what: string; queries: QueryLike[]; className?: string }) {
  const failed = queries.filter((q) => q.error)
  if (failed.length > 0) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load {what}</AlertTitle>
        <AlertDescription>
          <p>{errorMessage(failed[0]!.error)}</p>
          <Button
            variant="outline"
            size="sm"
            disabled={failed.some((q) => q.isFetching)}
            onClick={() => failed.forEach((q) => void q.refetch())}
          >
            <RefreshCw aria-hidden="true" />
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  return (
    <div role="status">
      <span className="sr-only">Loading {what}</span>
      <Skeleton className={cn("h-48 bg-card", className)} />
    </div>
  )
}

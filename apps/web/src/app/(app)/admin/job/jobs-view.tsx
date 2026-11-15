"use client"

import { useQuery } from "@tanstack/react-query"
import { ApiError } from "@/lib/api"
import { getAdminApi } from "@/lib/api/admin"
import { PageHeader } from "@/components/app/page-header"
import { EmptyState } from "@/components/app/empty-state"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { QueryFallback } from "@/components/app/query-fallback"

/**
 * Failed jobs. The backend answers 503 `queue_unavailable` when no queue is configured, which is a
 * real state (no Redis) and must not be drawn as "no failed jobs" — an empty list would look healthy.
 */
export function AdminJobsView() {
  const q = useQuery({
    queryKey: ["admin", "jobs"],
    queryFn: () => getAdminApi().jobsFailed(),
    staleTime: 30_000,
    retry: false,
  })
  const code = q.error instanceof ApiError ? q.error.code : undefined

  if (code === "queue_unavailable") {
    return (
      <div className="grid gap-6">
        <PageHeader title="Job gagal" />
        <Alert>
          <AlertTitle>Antrean job tidak aktif</AlertTitle>
          <AlertDescription>
            Backend ini berjalan tanpa Redis (REDIS_URL kosong), jadi operasi dijalankan langsung dan tidak ada job yang bisa gagal.
          </AlertDescription>
        </Alert>
      </div>
    )
  }
  if (q.isPending || q.error) return <QueryFallback what="job gagal" queries={[q]} />

  const jobs = q.data?.jobs ?? []
  return (
    <div className="grid gap-6">
      <PageHeader title="Job gagal" description="Job yang sudah kehabisan percobaan." />
      {jobs.length === 0 ? (
        <EmptyState title="Tidak ada job gagal" description="Semua job selesai atau masih punya sisa percobaan." />
      ) : (
        <ul className="grid gap-2">
          {jobs.map((j) => (
            <li key={j.id} className="flex flex-wrap items-baseline justify-between gap-3 rounded-sm border px-4 py-3">
              <span className="type-mono">{j.id}</span>
              <span className="type-mono text-muted-foreground">{j.reason ?? "—"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

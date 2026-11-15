"use client"

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState } from "@/components/app/empty-state"
import { QueryFallback } from "@/components/app/query-fallback"

type QueryLike = { error: unknown; refetch: () => unknown; isFetching: boolean; isPending: boolean }

/** The two states every admin list shares: still loading, or nothing to show. Renders `children` otherwise. */
export function AdminTable<T>({
  what,
  rows,
  queries,
  empty,
  head,
  row,
  caption,
}: {
  what: string
  rows: T[]
  queries: QueryLike[]
  empty: string
  head: React.ReactNode
  row: (item: T, index: number) => React.ReactNode
  caption?: string
}) {
  if (queries.some((q) => q.isPending || q.error)) {
    return <QueryFallback what={what} queries={queries} />
  }
  if (rows.length === 0) {
    return <EmptyState title="Belum ada data" description={empty} />
  }
  return (
    <Table>
      {caption ? <caption className="sr-only">{caption}</caption> : null}
      <TableHeader>
        <TableRow>{head}</TableRow>
      </TableHeader>
      <TableBody>{rows.map((item, i) => row(item, i))}</TableBody>
    </Table>
  )
}

export { TableCell, TableHead, TableRow }

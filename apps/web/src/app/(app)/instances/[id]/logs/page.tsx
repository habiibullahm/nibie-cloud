"use client"

import { useDeferredValue, useState } from "react"
import { Search, ShieldCheck } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { SectionTitle } from "@/components/app/page-header"
import { PreviewNote } from "@/components/app/preview-note"
import { useLogs } from "@/hooks/use-hermes"
import type { LogLevel } from "@/lib/api/types"
import { formatTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useInstanceId } from "../instance-frame"

export default function LogsPage() {
  const id = useInstanceId()
  const [level, setLevel] = useState<LogLevel | "all">("all")
  const [query, setQuery] = useState("")
  const [follow, setFollow] = useState(false)
  const q = useDeferredValue(query)
  const logs = useLogs(id, level, q)
  const qc = useQueryClient()

  useEffect(() => {
    if (!follow) return
    const t = setInterval(() => void qc.invalidateQueries({ queryKey: ["logs", id] }), 5000)
    return () => clearInterval(t)
  }, [follow, id, qc])

  return (
    <div className="grid gap-4">
      <SectionTitle aside={<PreviewNote what="Logs" />}>Logs</SectionTitle>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="grid flex-1 gap-2">
          <Label htmlFor="log-search">Search</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input id="log-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter messages" className="pl-10" />
          </div>
        </div>
        <div className="grid gap-2 sm:w-44">
          <Label htmlFor="log-level">Level</Label>
          <Select value={level} onValueChange={(v) => setLevel(v as LogLevel | "all")}>
            <SelectTrigger id="log-level" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All levels</SelectItem>
              <SelectItem value="error">Error</SelectItem>
              <SelectItem value="warn">Warning</SelectItem>
              <SelectItem value="info">Info</SelectItem>
              <SelectItem value="debug">Debug</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex h-10 items-center gap-3">
          <Switch id="log-follow" checked={follow} onCheckedChange={setFollow} />
          <Label htmlFor="log-follow">Follow</Label>
        </div>
      </div>

      <p className="flex items-center gap-2 text-muted-foreground">
        <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
        Logs are scoped to this instance and secrets are redacted before they reach you.
      </p>

      <div className="max-h-[560px] overflow-auto rounded-md border bg-card" role="log" aria-label="Instance logs" aria-live={follow ? "polite" : "off"}>
        {logs.isLoading ? (
          <Skeleton className="m-4 h-40 bg-elevated" />
        ) : logs.data && logs.data.length === 0 ? (
          <p className="p-4 text-muted-foreground">No log lines match these filters.</p>
        ) : (
          <ol className="type-mono min-w-max py-2">
            {logs.data?.map((l, i) => (
              <li key={i} className="grid grid-cols-[72px_56px_72px_minmax(0,1fr)] gap-3 px-4 py-1 hover:bg-row-hover">
                <time dateTime={l.t} className="text-muted-foreground">
                  {formatTime(l.t)}
                </time>
                <span className={cn("uppercase", l.level === "error" ? "text-foreground underline decoration-destructive decoration-2 underline-offset-4" : l.level === "debug" ? "text-muted-foreground" : "text-foreground")}>
                  {l.level}
                </span>
                <span className="text-muted-foreground">{l.source}</span>
                <span className="whitespace-pre">{l.message}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

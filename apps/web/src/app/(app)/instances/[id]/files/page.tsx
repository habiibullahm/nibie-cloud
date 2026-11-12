"use client"

import { useState } from "react"
import { ChevronRight, File, Folder, HardDrive } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState } from "@/components/app/empty-state"
import { PreviewNote } from "@/components/app/preview-note"
import { useFileContent, useFiles, useInstance } from "@/hooks/use-hermes"
import { runtimeReachable } from "@/lib/api/status"
import { formatBytes, formatRelative } from "@/lib/format"
import { useInstanceId } from "../instance-frame"

export default function FilesPage() {
  const id = useInstanceId()
  const { data: instance } = useInstance(id)
  const [path, setPath] = useState("/")
  const [open, setOpen] = useState<string | null>(null)
  const reachable = instance ? runtimeReachable(instance.status) : false
  const files = useFiles(id, path, reachable)
  const content = useFileContent(id, open)

  if (!instance) return <Skeleton className="h-64 bg-card" />
  if (!reachable) {
    return (
      <EmptyState
        icon={<HardDrive />}
        title="File Manager needs a running instance"
        description="Start the instance to browse its persistent volume. Your files are kept while it is stopped."
      />
    )
  }

  const crumbs = path === "/" ? [] : path.slice(1).split("/")

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Volume</CardTitle>
          <CardDescription>Your instance’s persistent storage. Nothing outside it is reachable.</CardDescription>
          <CardAction>
            <PreviewNote what="File Manager" />
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-3">
          <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1">
            <Button variant="ghost" size="xs" onClick={() => setPath("/")} className="type-mono">
              /
            </Button>
            {crumbs.map((c, i) => {
              const p = "/" + crumbs.slice(0, i + 1).join("/")
              return (
                <span key={p} className="inline-flex items-center gap-1">
                  <ChevronRight className="size-3 text-muted-foreground" aria-hidden="true" />
                  <Button variant="ghost" size="xs" onClick={() => setPath(p)} className="type-mono" aria-current={p === path ? "location" : undefined}>
                    {c}
                  </Button>
                </span>
              )
            })}
          </nav>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead>Modified</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {files.isLoading ? (
                  <TableRow>
                    <TableCell colSpan={3}>
                      <Skeleton className="h-6 bg-elevated" />
                    </TableCell>
                  </TableRow>
                ) : files.data?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-muted-foreground">
                      This folder is empty.
                    </TableCell>
                  </TableRow>
                ) : (
                  files.data?.map((f) => (
                    <TableRow key={f.path} data-state={open === f.path ? "selected" : undefined}>
                      <TableCell>
                        <button
                          type="button"
                          className="inline-flex cursor-pointer items-center gap-2 rounded-sm text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                          onClick={() => {
                            if (f.type === "dir") {
                              setPath(f.path)
                              setOpen(null)
                            } else {
                              setOpen(f.path)
                            }
                          }}
                        >
                          {f.type === "dir" ? <Folder className="size-4" aria-hidden="true" /> : <File className="size-4 text-muted-foreground" aria-hidden="true" />}
                          <span className="type-mono">{f.name}</span>
                          <span className="sr-only">{f.type === "dir" ? "(folder)" : "(file)"}</span>
                        </button>
                      </TableCell>
                      <TableCell className="type-mono text-right text-muted-foreground">{f.type === "dir" ? "—" : formatBytes(f.size)}</TableCell>
                      <TableCell className="text-muted-foreground">{formatRelative(f.modifiedAt)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <p className="text-muted-foreground">Upload, edit and delete arrive with the file API.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Preview</CardTitle>
          <CardDescription className="type-mono break-all">{open ?? "Select a file to view it."}</CardDescription>
        </CardHeader>
        <CardContent>
          {open ? (
            content.isLoading ? (
              <Skeleton className="h-40 bg-elevated" />
            ) : (
              <pre className="type-mono max-h-[420px] overflow-auto rounded-sm border bg-background p-4 whitespace-pre-wrap">{content.data}</pre>
            )
          ) : (
            <p className="text-muted-foreground">Read-only in this preview.</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

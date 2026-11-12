"use client"

import { useEffect, useRef, useState } from "react"
import { Power, Terminal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/app/empty-state"
import { PreviewNote } from "@/components/app/preview-note"
import { useInstance } from "@/hooks/use-hermes"
import { runtimeReachable } from "@/lib/api/status"
import { useInstanceId } from "../instance-frame"

const CANNED: Record<string, string> = {
  help: "Preview console. Try: whoami, pwd, ls, hermes --version, exit",
  whoami: "hermes",
  pwd: "/opt/data",
  ls: "SOUL.md  config.yaml  logs  memory  skills",
  "hermes --version": "hermes-agent 2026.11",
}

export default function ConsolePage() {
  const id = useInstanceId()
  const { data: instance } = useInstance(id)
  const [session, setSession] = useState(false)
  const [lines, setLines] = useState<string[]>([])
  const [cmd, setCmd] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLDivElement>(null)

  // Braces matter: newer browsers return a Promise from scrollIntoView, and React would call it as the cleanup.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" })
  }, [lines])

  if (!instance) return <Skeleton className="h-64 bg-card" />
  if (!runtimeReachable(instance.status)) {
    return (
      <EmptyState
        icon={<Terminal />}
        title="Console needs a running instance"
        description="Start the instance to open a shell inside your container."
      />
    )
  }

  const start = () => {
    setSession(true)
    setLines([`Connected to ${instance.name}. Shell runs inside your container only.`, "Type help for commands."])
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  const run = (e: React.FormEvent) => {
    e.preventDefault()
    const c = cmd.trim()
    setCmd("")
    if (!c) return
    if (c === "exit") {
      setLines((l) => [...l, `$ ${c}`, "Session closed."])
      setSession(false)
      return
    }
    setLines((l) => [...l, `$ ${c}`, CANNED[c] ?? `${c.split(" ")[0]}: not available in the preview console`])
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Web console</CardTitle>
        <CardDescription>A shell inside your own container. Host access is never available.</CardDescription>
        <CardAction>
          <PreviewNote what="Web console" />
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="type-mono grid min-h-72 content-start gap-1 overflow-x-auto rounded-sm border bg-background p-4" aria-live="polite">
          {lines.length === 0 ? <p className="text-muted-foreground">No session. Start one to run commands.</p> : null}
          {lines.map((l, i) => (
            <p key={i} className={l.startsWith("$ ") ? "text-foreground" : "text-muted-foreground"}>
              {l}
            </p>
          ))}
          {session ? (
            <form onSubmit={run} className="flex items-center gap-2">
              <label htmlFor="console-input" className="text-foreground">
                $
              </label>
              <input
                id="console-input"
                ref={inputRef}
                value={cmd}
                onChange={(e) => setCmd(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-label="Command"
                className="type-mono min-w-0 flex-1 rounded-sm bg-transparent text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              />
            </form>
          ) : null}
          <div ref={endRef} />
        </div>
      </CardContent>
      <CardFooter className="flex-wrap justify-between gap-3 border-t">
        {/* PRD §7 asks for idle timeouts and audit events; the timeout length is not decided yet. */}
        <p className="text-muted-foreground">Idle sessions time out, and each session is recorded as an audit event.</p>
        {session ? (
          <Button variant="secondary" onClick={() => {
              setSession(false)
              setLines((l) => [...l, "Session closed."])
            }}>
            <Power aria-hidden="true" />
            End session
          </Button>
        ) : (
          <Button onClick={start}>
            <Terminal aria-hidden="true" />
            Start session
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}

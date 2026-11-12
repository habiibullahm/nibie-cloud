"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { ApiError, getApi, type CreateInstanceInput, type Instance, type LogLevel } from "@/lib/api"
import { isTransitional, type InstanceAction } from "@/lib/api/status"

const POLL_MS = 1500

export const keys = {
  instances: ["instances"] as const,
  instance: (id: string) => ["instance", id] as const,
  events: (id: string) => ["events", id] as const,
  meta: (id: string) => ["meta", id] as const,
  plans: ["plans"] as const,
  regions: ["regions"] as const,
  me: ["me"] as const,
  access: (id: string) => ["access", id] as const,
  subscription: (id: string) => ["subscription", id] as const,
  usage: (id: string, r: string) => ["usage", id, r] as const,
  logs: (id: string, level: string, q: string) => ["logs", id, level, q] as const,
  provider: (id: string) => ["provider", id] as const,
  telegram: (id: string) => ["telegram", id] as const,
  files: (id: string, path: string) => ["files", id, path] as const,
  file: (id: string, path: string) => ["file", id, path] as const,
  backups: (id: string) => ["backups", id] as const,
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message
  return "Something went wrong. Try again."
}

export function useApiMode() {
  return getApi().mode
}

export function useInstances() {
  return useQuery({
    queryKey: keys.instances,
    queryFn: () => getApi().instances.list(),
    refetchInterval: (q) => (q.state.data?.some((i) => isTransitional(i.status)) ? POLL_MS : false),
  })
}

export function useInstance(id: string) {
  return useQuery({
    queryKey: keys.instance(id),
    queryFn: () => getApi().instances.get(id),
    refetchInterval: (q) => (q.state.data && isTransitional(q.state.data.status) ? POLL_MS : false),
  })
}

export function useEvents(id: string, poll: boolean) {
  return useQuery({
    queryKey: keys.events(id),
    queryFn: () => getApi().instances.events(id),
    refetchInterval: poll ? POLL_MS : false,
  })
}

export function useInstanceMeta(id: string) {
  return useQuery({ queryKey: keys.meta(id), queryFn: () => getApi().preview.meta(id) })
}

export function usePlans() {
  return useQuery({ queryKey: keys.plans, queryFn: () => getApi().preview.plans(), staleTime: Infinity })
}

export function useRegions() {
  return useQuery({ queryKey: keys.regions, queryFn: () => getApi().preview.regions(), staleTime: Infinity })
}

export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: () => getApi().preview.me(), staleTime: Infinity })
}

export function useAccess(id: string) {
  return useQuery({ queryKey: keys.access(id), queryFn: () => getApi().preview.access(id) })
}

export function useSubscription(id: string) {
  return useQuery({ queryKey: keys.subscription(id), queryFn: () => getApi().preview.subscription(id) })
}

export function useUsage(id: string, range: "1h" | "24h" | "7d") {
  return useQuery({ queryKey: keys.usage(id, range), queryFn: () => getApi().preview.usage(id, range) })
}

export function useLogs(id: string, level: LogLevel | "all", query: string) {
  return useQuery({
    queryKey: keys.logs(id, level, query),
    queryFn: () => getApi().preview.logs(id, { level, query }),
  })
}

export function useProvider(id: string) {
  return useQuery({ queryKey: keys.provider(id), queryFn: () => getApi().preview.provider(id) })
}

export function useTelegram(id: string) {
  return useQuery({ queryKey: keys.telegram(id), queryFn: () => getApi().preview.telegram(id) })
}

export function useFiles(id: string, path: string, enabled: boolean) {
  return useQuery({ queryKey: keys.files(id, path), queryFn: () => getApi().preview.files(id, path), enabled })
}

export function useFileContent(id: string, path: string | null) {
  return useQuery({
    queryKey: keys.file(id, path ?? ""),
    queryFn: () => getApi().preview.fileContent(id, path!),
    enabled: path !== null,
  })
}

export function useBackups(id: string) {
  return useQuery({
    queryKey: keys.backups(id),
    queryFn: () => getApi().preview.backups(id),
    refetchInterval: (q) => (q.state.data?.some((b) => b.status === "running") ? POLL_MS : false),
  })
}

export function useCreateInstance() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ input, idempotencyKey }: { input: CreateInstanceInput; idempotencyKey: string }) =>
      getApi().instances.create(input, idempotencyKey),
    onSuccess: (instance) => {
      qc.setQueryData(keys.instance(instance.id), instance)
      void qc.invalidateQueries({ queryKey: keys.instances })
    },
  })
}

const ACTION_COPY: Record<InstanceAction, { pending: string; done: string }> = {
  start: { pending: "Starting", done: "Start requested" },
  stop: { pending: "Stopping", done: "Stop requested" },
  restart: { pending: "Restarting", done: "Restart requested" },
  delete: { pending: "Deleting", done: "Deletion requested" },
}

export function useInstanceAction(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (action: InstanceAction): Promise<Instance> => {
      const api = getApi().instances
      switch (action) {
        case "start":
          return api.start(id)
        case "stop":
          return api.stop(id)
        case "restart":
          return api.restart(id)
        case "delete":
          return api.remove(id)
      }
    },
    onSuccess: (instance, action) => {
      qc.setQueryData(keys.instance(id), instance)
      void qc.invalidateQueries({ queryKey: keys.instances })
      void qc.invalidateQueries({ queryKey: keys.events(id) })
      toast.success(`${ACTION_COPY[action].done} for ${instance.name}`)
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
}

export function invalidateKey(qc: ReturnType<typeof useQueryClient>, key: readonly unknown[]) {
  return qc.invalidateQueries({ queryKey: key })
}

import { ApiError } from "./client"
import type { Call } from "./live"

/** Mirrors the backend enums (prisma/schema.prisma). */
export type TicketCategory = "PAYMENT" | "TECHNICAL" | "ACCOUNT" | "OTHER"
export type TicketStatus = "OPEN" | "ANSWERED" | "CLOSED"
export type TicketAuthor = "CUSTOMER" | "ADMIN"

export const TICKET_CATEGORIES: TicketCategory[] = ["TECHNICAL", "PAYMENT", "ACCOUNT", "OTHER"]

export interface TicketSummary {
  id: string
  subject: string
  category: TicketCategory
  status: TicketStatus
  createdAt: string
  lastMessageAt: string
  createdByEmail: string
  instance: { id: string; name: string } | null
}

export interface TicketMessage {
  id: string
  author: TicketAuthor
  body: string
  createdAt: string
}

export type TicketDetail = TicketSummary & { messages: TicketMessage[] }

export interface NewTicket {
  subject: string
  category: TicketCategory
  instanceId: string | null
  message: string
}

/** Customer support tickets (`/api/v1/support/tickets`). The backend keeps every call inside the customer's tenant. */
export interface TicketsApi {
  list(): Promise<TicketSummary[]>
  get(id: string): Promise<TicketDetail>
  create(input: NewTicket): Promise<TicketSummary>
  reply(id: string, message: string): Promise<TicketSummary>
  close(id: string): Promise<TicketSummary>
}

export function buildTicketsApi(call: Call): TicketsApi {
  const id = (s: string) => encodeURIComponent(s)
  const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  return {
    list: async () => (await call<{ tickets: TicketSummary[] }>("/support/tickets")).tickets,
    get: async (t) => (await call<{ ticket: TicketDetail }>(`/support/tickets/${id(t)}`)).ticket,
    create: async (input) => (await call<{ ticket: TicketSummary }>("/support/tickets", post(input))).ticket,
    reply: async (t, message) => (await call<{ ticket: TicketSummary }>(`/support/tickets/${id(t)}/messages`, post({ message }))).ticket,
    close: async (t) => (await call<{ ticket: TicketSummary }>(`/support/tickets/${id(t)}/close`, post({}))).ticket,
  }
}

/** Live mode (dev bridge) has no tickets: the list is empty and writes are refused. */
export function createUnavailableTicketsApi(): TicketsApi {
  const refuse = () => Promise.reject(new ApiError(404, "tickets_unavailable", "Support tickets are not available in this mode."))
  return { list: async () => [], get: refuse, create: refuse, reply: refuse, close: refuse }
}

/**
 * In-memory tickets for mock mode, so the screens can be tried without a backend. Starts empty (no invented conversations);
 * a ticket opened here gets no reply unless one is added through `reply`, which then counts as the customer's.
 */
export function createMockTicketsApi(email = "you@example.com"): TicketsApi {
  const tickets = new Map<string, TicketDetail>()
  const wait = () => new Promise((r) => setTimeout(r, 250))
  const summary = (t: TicketDetail): TicketSummary => ({
    id: t.id, subject: t.subject, category: t.category, status: t.status, createdAt: t.createdAt,
    lastMessageAt: t.lastMessageAt, createdByEmail: t.createdByEmail, instance: t.instance,
  })
  const find = (t: string) => {
    const found = tickets.get(t)
    if (!found) throw new ApiError(404, "not_found", "Ticket not found")
    return found
  }
  return {
    list: async () => {
      await wait()
      return [...tickets.values()].map(summary).sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
    },
    get: async (t) => {
      await wait()
      return find(t)
    },
    create: async (input) => {
      await wait()
      const now = new Date().toISOString()
      const t: TicketDetail = {
        id: crypto.randomUUID(), subject: input.subject, category: input.category, status: "OPEN", createdAt: now, lastMessageAt: now,
        createdByEmail: email, instance: null, messages: [{ id: crypto.randomUUID(), author: "CUSTOMER", body: input.message, createdAt: now }],
      }
      tickets.set(t.id, t)
      return summary(t)
    },
    reply: async (t, message) => {
      await wait()
      const found = find(t)
      const now = new Date().toISOString()
      const next: TicketDetail = { ...found, status: "OPEN", lastMessageAt: now, messages: [...found.messages, { id: crypto.randomUUID(), author: "CUSTOMER", body: message, createdAt: now }] }
      tickets.set(t, next)
      return summary(next)
    },
    close: async (t) => {
      await wait()
      const next: TicketDetail = { ...find(t), status: "CLOSED" }
      tickets.set(t, next)
      return summary(next)
    },
  }
}

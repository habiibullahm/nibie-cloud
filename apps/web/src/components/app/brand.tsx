import Link from "next/link"

/** Wordmark + glyph. The glyph is a plain geometric mark drawn in colors.primary. */
export function Brand({ href = "/instances" }: { href?: string }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2 rounded-sm text-foreground no-underline outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <svg viewBox="0 0 24 24" className="size-6 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="4" />
        <path d="M8 7v10M16 7v10M8 12h8" />
      </svg>
      <span className="type-label">Hermes Cloud</span>
    </Link>
  )
}

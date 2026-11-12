import Link from "next/link"

/**
 * Product name as a wordmark. No logo has been approved yet (antislop R-23), so there is no glyph;
 * replace this with the real mark when it exists.
 */
export function Brand({ href = "/instances" }: { href?: string }) {
  return (
    <Link
      href={href}
      className="hit-area relative flex w-fit items-center rounded-sm text-foreground no-underline outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <span className="type-label">Hermes Cloud</span>
    </Link>
  )
}

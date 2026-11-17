import Image from "next/image"
import Link from "next/link"

/** next/image does not add the base path to a string src (next.config.ts sets it to /dashboard). */
const MARK_SRC = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/brand/logo-mark-on-dark-128h.png`

/**
 * The approved brand mark (on-dark variant, DESIGN.md) beside the product name. The name carries the
 * link text, so the mark is decorative.
 */
export function Brand({ href = "/instances" }: { href?: string }) {
  return (
    <Link
      href={href}
      className="hit-area relative flex w-fit items-center gap-2 rounded-sm text-foreground no-underline outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Image src={MARK_SRC} alt="" aria-hidden="true" width={192} height={128} unoptimized loading="eager" className="h-6 w-auto shrink-0" />
      <span className="type-label">Nibie Cloud</span>
    </Link>
  )
}

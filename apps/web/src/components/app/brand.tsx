import Image from "next/image"
import Link from "next/link"

/** next/image does not add the base path to a string src (next.config.ts sets it to /dashboard). */
const MARK_SRC = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/brand/mark-paper.svg`

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
      {/* The on-dark mark has a near-white lobe: straight on the dark background, on an ink tile in the light theme. */}
      <span className="flex shrink-0 rounded-sm [[data-theme=light]_&]:bg-ink [[data-theme=light]_&]:p-0.5">
        <Image src={MARK_SRC} alt="" aria-hidden="true" width={30} height={20} unoptimized loading="eager" className="h-5 w-auto" />
      </span>
      <span className="font-heading text-base font-bold tracking-tight">Nibie Cloud</span>
    </Link>
  )
}

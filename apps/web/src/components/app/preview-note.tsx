import { FlaskConical } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

/**
 * Marks a section that shows sample data. Opens on click or tap (a hover tooltip never opens on
 * touch screens, antislop R-03).
 */
export function PreviewNote({ what = "This section", reason = "api" }: { what?: string; reason?: "api" | "mock" }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="type-label hit-area relative inline-flex items-center gap-2 rounded-sm border border-dashed border-input px-2 py-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <FlaskConical className="size-3" aria-hidden="true" />
          Preview data
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 text-sm">
        {reason === "mock"
          ? `${what} come from the in-browser mock, not your backend. Set NEXT_PUBLIC_HERMES_API_MODE=live to use real instances.`
          : `${what} uses sample data. Its API is planned (PRD §15) but not built yet.`}
      </PopoverContent>
    </Popover>
  )
}

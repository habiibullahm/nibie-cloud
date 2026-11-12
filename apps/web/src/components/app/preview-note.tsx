import { FlaskConical } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/** Marks a section whose endpoint does not exist on the backend yet (mock data). */
export function PreviewNote({ what = "This section" }: { what?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="type-label inline-flex cursor-help items-center gap-2 rounded-sm border border-dashed border-input px-2 py-1 text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <FlaskConical className="size-3" aria-hidden="true" />
          Preview data
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        {what} uses sample data. Its API is planned (PRD §15) but not built yet.
      </TooltipContent>
    </Tooltip>
  )
}

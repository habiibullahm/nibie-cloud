import { useId } from "react"

/**
 * Minimal SVG area/line chart. Neutral token colors only (colors.primary line, colors.border grid);
 * DESIGN.md defines no chart palette, so a single series per chart keeps it unambiguous.
 */
export function LineChart({
  values,
  max,
  label,
  format,
  height = 120,
}: {
  values: number[]
  max: number
  label: string
  format: (v: number) => string
  height?: number
}) {
  const id = useId()
  const w = 600
  const h = height
  const n = values.length
  const safeMax = max > 0 ? max : 1
  const pts = values.map((v, i) => [n > 1 ? (i / (n - 1)) * w : 0, h - (Math.min(v, safeMax) / safeMax) * (h - 4) - 2] as const)
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ")
  const area = n > 0 ? `${line} L${w},${h} L0,${h} Z` : ""
  const last = values.at(-1) ?? 0
  const peak = values.length ? Math.max(...values) : 0
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0

  return (
    <figure className="grid gap-2">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="h-[120px] w-full text-foreground"
        role="img"
        aria-labelledby={`${id}-t`}
      >
        <title id={`${id}-t`}>{`${label}: now ${format(last)}, peak ${format(peak)}, average ${format(avg)}`}</title>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={w} y1={h * f} y2={h * f} stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        ))}
        <path d={area} fill="var(--secondary)" opacity="0.6" />
        <path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
        <span>
          Now <span className="type-mono text-foreground">{format(last)}</span>
        </span>
        <span>
          Peak <span className="type-mono text-foreground">{format(peak)}</span>
        </span>
        <span>
          Avg <span className="type-mono text-foreground">{format(avg)}</span>
        </span>
      </figcaption>
    </figure>
  )
}

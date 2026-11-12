export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-dashed bg-card px-6 py-12 text-center">
      {icon ? <div className="text-muted-foreground [&_svg]:size-6">{icon}</div> : null}
      <h2 className="type-label text-foreground">{title}</h2>
      <p className="max-w-[48ch] text-muted-foreground">{description}</p>
      {action ? <div className="pt-2">{action}</div> : null}
    </div>
  )
}

import { useMemo, useState, type ReactNode } from "react"
import { ChevronDown, Filter, X } from "lucide-react"

import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export type FilterOption = {
  value: string
  label: string
  /** Optional custom render — when present, used in place of `label` so the
   * filter row matches the cell render (e.g. coloured dot + coloured text).
   * `label` is still used for the active-filter chip and search matching. */
  render?: ReactNode
  count?: number
}

/**
 * Click-to-filter column header. Renders the title with a small chevron;
 * clicking opens a popover with the discrete values present in the column.
 * Picking one sets the filter; the active one is shown as a chip; clicking it
 * again clears.
 */
export function ColumnFilter({
  title,
  value,
  onChange,
  options,
  align = "start",
}: {
  title: string
  value: string | null
  onChange: (v: string | null) => void
  options: FilterOption[]
  align?: "start" | "center" | "end"
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim()
    if (!q) return options
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
    )
  }, [options, query])

  const active = value !== null
  const activeOption = options.find((o) => o.value === value)
  const activeLabel = activeOption?.label ?? value

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1 rounded px-1 -mx-1 py-0.5 text-left hover:bg-accent",
            active && "text-foreground",
          )}
        >
          <span className="font-medium">{title}</span>
          {active ? (
            <Filter className="h-3 w-3 fill-current" />
          ) : (
            <ChevronDown className="h-3 w-3 opacity-50" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-56 p-0">
        <div className="border-b p-2">
          <div className="text-xs font-medium text-muted-foreground">
            Filter
          </div>
          {options.length > 6 && (
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="mt-2 h-7 text-xs"
            />
          )}
        </div>
        {active && (
          <button
            type="button"
            onClick={() => {
              onChange(null)
              setOpen(false)
            }}
            className="flex w-full items-center justify-between border-b px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"
          >
            <span>
              Active: <span className="font-medium text-foreground">{activeLabel}</span>
            </span>
            <X className="h-3 w-3" />
          </button>
        )}
        <div className="max-h-64 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">No matches.</div>
          ) : (
            filtered.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  onChange(opt.value === value ? null : opt.value)
                  setOpen(false)
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent",
                  value === opt.value && "bg-accent font-medium",
                )}
              >
                <span className="truncate">{opt.render ?? opt.label}</span>
                {opt.count !== undefined && (
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {opt.count}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

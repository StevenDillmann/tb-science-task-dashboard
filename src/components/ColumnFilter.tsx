import { useMemo, useState, type ReactNode } from "react"
import { ArrowDown, ArrowUp, Check, ChevronDown, Filter, X } from "lucide-react"

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
  value = null,
  onChange,
  options,
  align = "start",
  heading = "Filter",
  sortValue = null,
  onSortChange,
  sortOptions,
  sortHeading = "Sort",
  selected,
  onToggle,
  onClearAll,
  open: openProp,
  onOpenChange,
}: {
  title: string
  value?: string | null
  onChange?: (v: string | null) => void
  options: FilterOption[]
  align?: "start" | "center" | "end"
  /** Filter-section heading (default "Filter"). */
  heading?: string
  /** Multi-select mode: when `selected` is provided, options toggle in/out of
   *  the set (OR semantics) instead of single-select. `value`/`onChange` are
   *  ignored in this mode. */
  selected?: string[]
  onToggle?: (v: string) => void
  onClearAll?: () => void
  /** When `sortOptions` is provided, a Sort section renders below the filter
   *  options so one header button can both filter and sort the column. */
  sortValue?: string | null
  onSortChange?: (v: string | null) => void
  sortOptions?: FilterOption[]
  sortHeading?: string
  /** Controlled open state — pass both to lift it out of the component so it
   *  survives header re-renders (e.g. while multi-selecting). Uncontrolled if
   *  omitted. */
  open?: boolean
  onOpenChange?: (v: boolean) => void
}) {
  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState
  const setOpen = onOpenChange ?? setOpenState
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim()
    if (!q) return options
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
    )
  }, [options, query])

  const multiple = selected !== undefined
  const isSelected = (v: string) => (multiple ? selected!.includes(v) : value === v)
  const filterActive = multiple ? selected!.length > 0 : value !== null
  const hasFilter = options.length > 0
  const hasSort = !!sortOptions && sortOptions.length > 0
  const active = filterActive || sortValue !== null
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
          <span className="whitespace-nowrap font-medium">{title}</span>
          {filterActive ? (
            <Filter className="h-3 w-3 fill-current" />
          ) : sortValue !== null ? (
            sortValue.endsWith(":asc") ? (
              <ArrowUp className="h-3 w-3" />
            ) : (
              <ArrowDown className="h-3 w-3" />
            )
          ) : (
            <ChevronDown className="h-3 w-3 opacity-50" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-56 p-0">
        {/* Filter section (first) */}
        {hasFilter && (
          <>
            <div className="border-b p-2">
              <div className="text-xs font-medium text-muted-foreground">
                {heading}
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
            {filterActive && (
              <button
                type="button"
                onClick={() => {
                  if (multiple) onClearAll?.()
                  else onChange?.(null)
                  setOpen(false)
                }}
                className="flex w-full items-center justify-between border-b px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"
              >
                <span>
                  {multiple ? (
                    <>Clear <span className="font-medium text-foreground">{selected!.length}</span> selected</>
                  ) : (
                    <>Active: <span className="font-medium text-foreground">{activeLabel}</span></>
                  )}
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
                      if (multiple) {
                        onToggle?.(opt.value)
                      } else {
                        onChange?.(opt.value === value ? null : opt.value)
                        setOpen(false)
                      }
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent",
                      isSelected(opt.value) && "bg-accent font-medium",
                    )}
                  >
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      {multiple && (
                        <Check
                          className={cn(
                            "h-3 w-3 shrink-0",
                            isSelected(opt.value) ? "opacity-100" : "opacity-0",
                          )}
                          strokeWidth={3}
                        />
                      )}
                      <span className="truncate">{opt.render ?? opt.label}</span>
                    </span>
                    {opt.count !== undefined && (
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {opt.count}
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
          </>
        )}
        {/* Sort section (below filter) */}
        {hasSort && (
          <div className={cn("py-1", hasFilter && "border-t")}>
            <div className="px-3 pt-1 pb-0.5 text-xs font-medium text-muted-foreground">
              {sortHeading}
            </div>
            {sortOptions!.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  onSortChange?.(opt.value === sortValue ? null : opt.value)
                  setOpen(false)
                }}
                className={cn(
                  "flex w-full items-center px-3 py-1.5 text-left text-sm hover:bg-accent",
                  sortValue === opt.value && "bg-accent font-medium",
                )}
              >
                {opt.render ?? opt.label}
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

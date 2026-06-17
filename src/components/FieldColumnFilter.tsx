import { useState } from "react"
import { ChevronDown, Filter, X } from "lucide-react"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { DOMAIN_LABELS, type Domain } from "@/lib/data"
import { useTaxonomy } from "@/lib/taxonomy"

const KNOWN_ORDER: Domain[] = [
  "earth-sciences",
  "life-sciences",
  "physical-sciences",
  "mathematical-sciences",
  "other",
]

const DOMAIN_SENTINEL_PREFIX = "__domain:"
const domainSentinel = (d: string) => `${DOMAIN_SENTINEL_PREFIX}${d}`

/**
 * Field filter popover with options grouped by parent domain. Used as the
 * Field column header in PRs and Proposals tables.
 */
export function FieldColumnFilter({
  value,
  onChange,
  counts,
}: {
  value: string | null
  onChange: (v: string | null) => void
  counts?: Record<string, number>
}) {
  const [open, setOpen] = useState(false)
  const { taxonomy, field_labels } = useTaxonomy()

  const domains = Object.keys(taxonomy) as Domain[]
  const sortedDomains = [
    ...KNOWN_ORDER.filter((d) => domains.includes(d)),
    ...domains.filter((d) => !KNOWN_ORDER.includes(d)),
  ]

  const active = value !== null
  let activeLabel: string | null = null
  if (value) {
    if (value.startsWith(DOMAIN_SENTINEL_PREFIX)) {
      const dom = value.slice(DOMAIN_SENTINEL_PREFIX.length) as Domain
      activeLabel = `${DOMAIN_LABELS[dom] ?? dom} (uncategorized)`
    } else {
      activeLabel = field_labels[value] ?? value
    }
  }

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
          <span className="font-medium">FIELD</span>
          {active ? (
            <Filter className="h-3 w-3 fill-current" />
          ) : (
            <ChevronDown className="h-3 w-3 opacity-50" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <div className="border-b p-2 text-xs font-medium text-muted-foreground">
          Filter
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
        <div className="max-h-72 overflow-y-auto py-1">
          {sortedDomains.map((domain) => {
            const subs = Object.keys(taxonomy[domain])
            // Domains with no discovered subfields (e.g. `other`) get a single
            // selectable "(uncategorized)" entry that filters by domain.
            if (subs.length === 0) {
              const sentinel = domainSentinel(domain)
              const n = counts?.[sentinel]
              return (
                <div key={domain}>
                  <div className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {DOMAIN_LABELS[domain] ?? domain}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(sentinel === value ? null : sentinel)
                      setOpen(false)
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm italic text-muted-foreground hover:bg-accent",
                      value === sentinel && "bg-accent font-medium not-italic text-foreground",
                    )}
                  >
                    <span className="truncate">(uncategorized)</span>
                    {n !== undefined && (
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {n}
                      </span>
                    )}
                  </button>
                </div>
              )
            }
            return (
              <div key={domain}>
                <div className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {DOMAIN_LABELS[domain] ?? domain}
                </div>
                {subs.map((sub) => {
                  const n = counts?.[sub]
                  return (
                    <button
                      key={sub}
                      type="button"
                      onClick={() => {
                        onChange(sub === value ? null : sub)
                        setOpen(false)
                      }}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent",
                        value === sub && "bg-accent font-medium",
                      )}
                    >
                      <span className="truncate">{field_labels[sub] ?? sub}</span>
                      {n !== undefined && (
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {n}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

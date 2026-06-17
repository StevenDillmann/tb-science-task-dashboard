import type { ReactNode } from "react"
import { X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { DOMAIN_LABELS, type Domain } from "@/lib/data"
import { useTaxonomy } from "@/lib/taxonomy"

export type Option = { value: string; label: string }

export function ChipFilter({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label: string
  value: string | null
  onChange: (v: string | null) => void
  options: Option[]
  className?: string
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      <span className="mr-1 text-xs text-muted-foreground">{label}:</span>
      <Button
        variant={value === null ? "secondary" : "ghost"}
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={() => onChange(null)}
      >
        all
      </Button>
      {options.map((opt) => (
        <Button
          key={opt.value}
          variant={value === opt.value ? "secondary" : "ghost"}
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </Button>
      ))}
    </div>
  )
}

/**
 * Field filter grouped by parent domain. Lays out 12 chips in 4 lines, one per
 * domain, each line prefixed with the domain label. Lets reviewers scan by
 * domain shape while keeping field as the actual filter dimension.
 */
export function FieldFilter({
  value,
  onChange,
}: {
  value: string | null
  onChange: (v: string | null) => void
}) {
  const { taxonomy, field_labels } = useTaxonomy()
  // Only show domains that actually have subfields discovered under them.
  const domains = (Object.keys(taxonomy) as Domain[]).filter(
    (d) => Object.keys(taxonomy[d]).length > 0,
  )
  // Stable order: known domain order first, then any extras.
  const KNOWN_ORDER: Domain[] = [
    "earth-sciences",
    "life-sciences",
    "physical-sciences",
    "mathematical-sciences",
  ]
  const sortedDomains = [
    ...KNOWN_ORDER.filter((d) => domains.includes(d)),
    ...domains.filter((d) => !KNOWN_ORDER.includes(d)),
  ]
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
      <span className="mr-1 text-xs text-muted-foreground">Field:</span>
      <Button
        variant={value === null ? "secondary" : "ghost"}
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={() => onChange(null)}
      >
        all
      </Button>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        {sortedDomains.map((domain) => (
          <div key={domain} className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
              {DOMAIN_LABELS[domain] ?? domain}
            </span>
            {Object.keys(taxonomy[domain]).map((sub) => (
              <Button
                key={sub}
                variant={value === sub ? "secondary" : "ghost"}
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => onChange(sub)}
              >
                {field_labels[sub] ?? sub}
              </Button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Small chip showing an active column filter, with an × to remove it. */
export function FilterChip({
  label,
  value,
  onClear,
}: {
  label: string
  value: ReactNode
  onClear: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClear}
      className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-xs hover:bg-accent"
      title={`Clear ${label} filter`}
    >
      <span className="text-muted-foreground">{label}:</span>
      <span>{value}</span>
      <X className="h-3 w-3 text-muted-foreground" />
    </button>
  )
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
}) {
  return (
    <div className={cn("relative", className)}>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "Search…"}
        className="h-8 pr-7"
      />
      {value && (
        <button
          className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-accent"
          onClick={() => onChange("")}
          aria-label="Clear search"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}

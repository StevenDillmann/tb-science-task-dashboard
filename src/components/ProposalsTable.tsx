import { useEffect, useMemo, useState } from "react"
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table"
import { ArrowUpDown, Check, Clock, ExternalLink, Plus, X as XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { DOMAIN_LABELS, type Domain, type Proposal } from "@/lib/data"
import { useTaxonomy } from "@/lib/taxonomy"
import { cn } from "@/lib/utils"
import { FieldChip, HumanReviewChip, LLMReviewChip, StatePill, UserCell } from "./Chips"
import { ColumnFilter } from "./ColumnFilter"
import { FieldColumnFilter } from "./FieldColumnFilter"
import { FilterChip, SearchInput } from "./Filters"
import { ProposalSheet } from "./ProposalSheet"

function IconLabel({
  icon,
  text,
  label,
}: {
  icon: "check" | "question" | "x" | "clock"
  text: string
  label: string
}) {
  return (
    <span className={cn("inline-flex items-center gap-1 font-medium", text)}>
      {icon === "check" && <Check className="h-3 w-3" strokeWidth={3} />}
      {icon === "x" && <XIcon className="h-3 w-3" strokeWidth={3} />}
      {icon === "clock" && <Clock className="h-3 w-3" strokeWidth={2} />}
      {icon === "question" && (
        <span className="inline-flex h-3 w-3 items-center justify-center text-[13px] font-bold leading-none">
          ?
        </span>
      )}
      {label}
    </span>
  )
}

const LLM_OPTIONS = [
  {
    value: "accept",
    label: "accept",
    render: <IconLabel icon="check" text="text-green-700 dark:text-green-400" label="accept" />,
  },
  {
    value: "uncertain",
    label: "uncertain",
    render: <IconLabel icon="question" text="text-amber-700 dark:text-amber-400" label="uncertain" />,
  },
  {
    value: "reject",
    label: "reject",
    render: <IconLabel icon="x" text="text-red-700 dark:text-red-400" label="reject" />,
  },
]

const HUMAN_OPTIONS = [
  {
    value: "approved",
    label: "approved",
    render: <IconLabel icon="check" text="text-green-700 dark:text-green-400" label="approved" />,
  },
  {
    value: "pending",
    label: "pending",
    render: <IconLabel icon="clock" text="text-amber-700 dark:text-amber-400" label="pending" />,
  },
  {
    value: "rejected",
    label: "declined",
    render: <IconLabel icon="x" text="text-red-700 dark:text-red-400" label="declined" />,
  },
]

/** Pill toggle: All / Open / Approved / Closed for proposals.
 *
 * Mirrors the PR Open/Merged/Closed pill — "approved" is the positive
 * terminal state (analogous to "merged" on PRs). It is derived in the
 * UI from `state === "closed" && status === "approved"`; the data
 * model keeps `state` ("open" | "closed") and `status` separate. */
type ProposalStateFilter = "open" | "approved" | "closed"

function StateToggle({
  value,
  onChange,
  counts,
  total,
}: {
  value: ProposalStateFilter | "all"
  onChange: (v: ProposalStateFilter | "all") => void
  counts: Record<ProposalStateFilter, number>
  total: number
}) {
  const items: { value: ProposalStateFilter | "all"; label: string; count: number }[] = [
    { value: "all", label: "All", count: total },
    { value: "open", label: "Open", count: counts.open ?? 0 },
    { value: "approved", label: "Approved", count: counts.approved ?? 0 },
    { value: "closed", label: "Closed", count: counts.closed ?? 0 },
  ]
  return (
    <div className="inline-flex items-center rounded-full border p-1" role="radiogroup" aria-label="State">
      {items.map((it) => {
        const active = value === it.value
        return (
          <button
            key={it.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(it.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-0.5 text-xs font-medium transition-colors",
              active
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {it.label}
            <span
              className={cn(
                "font-mono text-[10px]",
                active ? "text-accent-foreground/70" : "text-muted-foreground/70",
              )}
            >
              {it.count}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function formatPostedDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  })
}

function countBy<T>(items: T[], key: (t: T) => string | null): Record<string, number> {
  const out: Record<string, number> = {}
  for (const it of items) {
    const k = key(it)
    if (k == null) continue
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}

export function ProposalsTable({
  proposals,
  externalField,
  externalStatus,
  onExternalFieldConsumed,
}: {
  proposals: Proposal[]
  externalField?: string | null
  externalStatus?: "approved" | "pending" | "rejected" | null
  onExternalFieldConsumed?: () => void
}) {
  const { field_labels } = useTaxonomy()
  const [sorting, setSorting] = useState<SortingState>([
    // Newest first — sort by Task Proposal number descending. Avoids ties
    // between proposals submitted on the same day that age_days can't break.
    { id: "proposal_number", desc: true },
  ])
  const [search, setSearch] = useState("")
  const [state, setState] = useState<ProposalStateFilter | "all">("open")
  const [active, setActive] = useState<Proposal | null>(null)
  const [field, setField] = useState<string | null>(null)
  const [author, setAuthor] = useState<string | null>(null)
  const [llm, setLlm] = useState<string | null>(null)
  const [human, setHuman] = useState<string | null>(null)

  // Derive the 3-way bucket (open / approved / closed) from the
  // underlying `state` + `status` fields. "Approved" peels off
  // GH-closed proposals that the maintainers approved; everything
  // else closed (declined, abandoned, no decision) stays in "closed".
  const bucketOf = (p: Proposal): ProposalStateFilter => {
    if (p.state === "open") return "open"
    return p.status === "approved" ? "approved" : "closed"
  }

  const stateCounts = useMemo(() => {
    const c: Record<ProposalStateFilter, number> = { open: 0, approved: 0, closed: 0 }
    for (const p of proposals) c[bucketOf(p)] += 1
    return c
  }, [proposals])

  // When the Stats tab forwards filters, apply them and reset state to "all"
  // so every matching proposal shows up regardless of open/closed.
  useEffect(() => {
    if (externalField || externalStatus) {
      if (externalField) setField(externalField)
      setHuman(externalStatus ?? null)
      setState("all")
      onExternalFieldConsumed?.()
    }
  }, [externalField, externalStatus, onExternalFieldConsumed])

  const filtered = useMemo(() => {
    const needle = search.toLowerCase().trim()
    return proposals.filter((p) => {
      if (state !== "all" && bucketOf(p) !== state) return false
      if (field) {
        if (field.startsWith("__domain:")) {
          if (p.domain !== field.slice("__domain:".length)) return false
        } else if (p.subfield !== field) return false
      }
      if (author && p.author.login !== author) return false
      if (llm) {
        const rec = p.llm_review?.recommendation ?? null
        if (llm === "none" ? rec !== null : rec !== llm) return false
      }
      if (human && p.status !== human) return false
      if (needle) {
        const hay = `${p.title} ${p.author.login} ${p.field ?? ""}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [proposals, search, state, field, author, llm, human])

  const stateFiltered = useMemo(
    () =>
      state === "all" ? proposals : proposals.filter((p) => p.state === state),
    [proposals, state],
  )
  const fieldCounts = useMemo(() => {
    const c = countBy(stateFiltered, (p) => p.subfield)
    for (const p of stateFiltered) {
      if (!p.subfield && p.domain) {
        const key = `__domain:${p.domain}`
        c[key] = (c[key] ?? 0) + 1
      }
    }
    return c
  }, [stateFiltered])
  const authorOptions = useMemo(() => {
    const c = countBy(stateFiltered, (p) => p.author.login)
    return Object.entries(c)
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, label: value, count }))
  }, [stateFiltered])

  const columns = useMemo<ColumnDef<Proposal>[]>(
    () => [
      {
        accessorKey: "proposal_number",
        header: "#",
        cell: ({ row }) => {
          const p = row.original
          // 3-state: open → open; closed+approved → approved; any other
          // closed (declined, withdrawn, no decision) → declined.
          const tone: "open" | "approved" | "declined" =
            p.state === "open" ? "open" : p.status === "approved" ? "approved" : "declined"
          return (
            <span className="inline-flex flex-col items-start gap-1">
              <a
                href={p.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:underline"
              >
                {p.proposal_number ?? p.number}
                <ExternalLink className="h-3 w-3" />
              </a>
              <StatePill tone={tone} label={tone} />
            </span>
          )
        },
        size: 70,
      },
      {
        accessorKey: "title",
        size: 380,
        header: ({ column }) => (
          <button
            className="inline-flex items-center gap-1"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            TITLE <ArrowUpDown className="h-3 w-3" />
          </button>
        ),
        cell: ({ row }) => (
          <button
            type="button"
            onClick={() => setActive(row.original)}
            className="text-left font-medium hover:underline underline-offset-4"
          >
            {row.original.title}
          </button>
        ),
      },
      {
        accessorKey: "subfield",
        size: 220,
        header: () => (
          <FieldColumnFilter value={field} onChange={setField} counts={fieldCounts} />
        ),
        cell: ({ row }) => (
          <FieldChip subfield={row.original.subfield} fallback={row.original.field} />
        ),
      },
      {
        accessorKey: "author",
        size: 180,
        header: () => (
          <ColumnFilter
            title="AUTHOR"
            value={author}
            onChange={setAuthor}
            options={authorOptions}
          />
        ),
        cell: ({ row }) => <UserCell user={row.original.author} />,
      },
      {
        accessorKey: "llm_review",
        size: 140,
        header: () => (
          <ColumnFilter
            title="LLM REVIEW"
            value={llm}
            onChange={setLlm}
            options={LLM_OPTIONS}
          />
        ),
        cell: ({ row }) => (
          <LLMReviewChip
            recommendation={row.original.llm_review?.recommendation ?? null}
            url={row.original.llm_review?.url ?? null}
          />
        ),
      },
      {
        accessorKey: "status",
        size: 150,
        header: () => (
          <ColumnFilter
            title="HUMAN REVIEW"
            value={human}
            onChange={setHuman}
            options={HUMAN_OPTIONS}
          />
        ),
        cell: ({ row }) => <HumanReviewChip status={row.original.status} />,
      },
      {
        accessorKey: "updated_days",
        size: 100,
        header: ({ column }) => (
          <button
            className="inline-flex items-start gap-1 text-left"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            <span className="font-medium">UPDATED</span>
            <ArrowUpDown className="mt-0.5 h-3 w-3 shrink-0" />
          </button>
        ),
        cell: ({ row }) => {
          const d = row.original.updated_days
          return (
            <span className="text-muted-foreground">{d === 0 ? "today" : `${d}d`}</span>
          )
        },
      },
      {
        accessorKey: "age_days",
        size: 110,
        header: ({ column }) => (
          <button
            className="inline-flex items-start gap-1 text-left"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            <span className="font-medium">POSTED</span>
            <ArrowUpDown className="mt-0.5 h-3 w-3 shrink-0" />
          </button>
        ),
        cell: ({ row }) => (
          <span
            className="text-muted-foreground"
            title={`${row.original.age_days} days ago`}
          >
            {formatPostedDate(row.original.created_at)}
          </span>
        ),
      },
    ],
    [field, author, llm, human, fieldCounts, authorOptions],
  )

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  const anyFilter = !!(search || field || author || llm || human)

  return (
    <>
    <ProposalSheet
      proposal={active}
      open={active !== null}
      onOpenChange={(v) => !v && setActive(null)}
    />
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-3">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search"
          className="max-w-md"
        />
        <StateToggle value={state} onChange={setState} counts={stateCounts} total={proposals.length} />
        {anyFilter && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            onClick={() => {
              setSearch("")
              setField(null)
              setAuthor(null)
              setLlm(null)
              setHuman(null)
            }}
          >
            Clear filters
          </Button>
        )}
        {field && (
          <FilterChip
            label="Field"
            value={
              field.startsWith("__domain:")
                ? `${DOMAIN_LABELS[field.slice("__domain:".length) as Domain] ?? field.slice("__domain:".length)} (other)`
                : (field_labels[field] ?? field)
            }
            onClear={() => setField(null)}
          />
        )}
        {author && (
          <FilterChip label="Author" value={author} onClear={() => setAuthor(null)} />
        )}
        {llm && (
          <FilterChip
            label="LLM review"
            value={llm}
            onClear={() => setLlm(null)}
          />
        )}
        {human && (
          <FilterChip
            label="Human review"
            value={human === "rejected" ? "declined" : human}
            onClear={() => setHuman(null)}
          />
        )}
        <span className="text-xs text-muted-foreground">
          {filtered.length} {filtered.length === 1 ? "row" : "rows"}
        </span>
        <a
          href="https://airtable.com/appzZC5gEHrXSfNNw/pagjgS95lAQ5FVJxt/form"
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background transition-opacity hover:opacity-90"
        >
          <Plus className="h-3.5 w-3.5" />
          Submit a proposal
        </a>
      </div>

      <div className="rounded-lg border">
        <Table className="table-fixed">
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((h) => (
                  <TableHead key={h.id} style={{ width: h.getSize() }}>
                    {h.isPlaceholder
                      ? null
                      : flexRender(h.column.columnDef.header, h.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                  No task proposals match these filters.
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
    </>
  )
}

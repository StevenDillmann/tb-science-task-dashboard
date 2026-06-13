import { useMemo, useState } from "react"
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table"
import { ArrowUpDown, ExternalLink, Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { type Proposal, type ProposalState } from "@/lib/data"
import { cn } from "@/lib/utils"
import { FieldChip, LLMReviewChip, UserCell } from "./Chips"
import { ColumnFilter } from "./ColumnFilter"
import { FieldColumnFilter } from "./FieldColumnFilter"
import { SearchInput } from "./Filters"

const LLM_OPTIONS = [
  { value: "accept", label: "🟢 accept" },
  { value: "uncertain", label: "🟡 uncertain" },
  { value: "reject", label: "🔴 reject" },
  { value: "none", label: "no review yet" },
]

/** Pill toggle: Open / Approved / Closed for proposals. */
function StateToggle({
  value,
  onChange,
  counts,
}: {
  value: ProposalState
  onChange: (v: ProposalState) => void
  counts: Record<ProposalState, number>
}) {
  const items: { value: ProposalState; label: string }[] = [
    { value: "open", label: "Open" },
    { value: "approved", label: "Approved" },
    { value: "closed", label: "Closed" },
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
              {counts[it.value] ?? 0}
            </span>
          </button>
        )
      })}
    </div>
  )
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

export function ProposalsTable({ proposals }: { proposals: Proposal[] }) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "age_days", desc: false },
  ])
  const [search, setSearch] = useState("")
  const [state, setState] = useState<ProposalState>("open")
  const [field, setField] = useState<string | null>(null)
  const [author, setAuthor] = useState<string | null>(null)
  const [llm, setLlm] = useState<string | null>(null)

  const stateCounts = useMemo(() => {
    const c: Record<ProposalState, number> = { open: 0, approved: 0, closed: 0 }
    for (const p of proposals) c[p.state] = (c[p.state] ?? 0) + 1
    return c
  }, [proposals])

  const filtered = useMemo(() => {
    const needle = search.toLowerCase().trim()
    return proposals.filter((p) => {
      if (p.state !== state) return false
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
      if (needle) {
        const hay = `${p.title} ${p.author.login} ${p.field ?? ""}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [proposals, search, state, field, author, llm])

  const fieldCounts = useMemo(() => {
    const c = countBy(proposals, (p) => p.subfield)
    for (const p of proposals) {
      if (!p.subfield && p.domain) {
        const key = `__domain:${p.domain}`
        c[key] = (c[key] ?? 0) + 1
      }
    }
    return c
  }, [proposals])
  const authorOptions = useMemo(() => {
    const c = countBy(proposals, (p) => p.author.login)
    return Object.entries(c)
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, label: value, count }))
  }, [proposals])

  const columns = useMemo<ColumnDef<Proposal>[]>(
    () => [
      {
        accessorKey: "proposal_number",
        header: "#",
        cell: ({ row }) => (
          <a
            href={row.original.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:underline"
          >
            {row.original.proposal_number ?? row.original.number}
            <ExternalLink className="h-3 w-3" />
          </a>
        ),
        size: 70,
      },
      {
        accessorKey: "title",
        header: ({ column }) => (
          <button
            className="inline-flex items-center gap-1"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Title <ArrowUpDown className="h-3 w-3" />
          </button>
        ),
        cell: ({ row }) => (
          <a
            href={row.original.url}
            target="_blank"
            rel="noreferrer"
            className="font-medium hover:underline"
          >
            {row.original.title}
          </a>
        ),
      },
      {
        accessorKey: "subfield",
        header: () => (
          <FieldColumnFilter value={field} onChange={setField} counts={fieldCounts} />
        ),
        cell: ({ row }) => (
          <FieldChip subfield={row.original.subfield} fallback={row.original.field} />
        ),
      },
      {
        accessorKey: "llm_review",
        header: () => (
          <ColumnFilter
            title="LLM review"
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
        accessorKey: "author",
        header: () => (
          <ColumnFilter
            title="Author"
            value={author}
            onChange={setAuthor}
            options={authorOptions}
          />
        ),
        cell: ({ row }) => <UserCell user={row.original.author} />,
      },
      {
        accessorKey: "age_days",
        header: ({ column }) => (
          <button
            className="inline-flex items-center gap-1"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Age <ArrowUpDown className="h-3 w-3" />
          </button>
        ),
        cell: ({ row }) => (
          <span className="text-muted-foreground">{row.original.age_days}d</span>
        ),
      },
    ],
    [field, author, llm, fieldCounts, authorOptions],
  )

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  const anyFilter = !!(search || field || author || llm)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-3">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search"
          className="max-w-md"
        />
        <StateToggle value={state} onChange={setState} counts={stateCounts} />
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
            }}
          >
            Clear filters
          </Button>
        )}
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
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((h) => (
                  <TableHead key={h.id}>
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
  )
}

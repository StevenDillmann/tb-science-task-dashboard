import { useEffect, useMemo, useState } from "react"
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table"
import { ArrowUpDown, CheckCircle2, Clock, ExternalLink, Plus, XCircle } from "lucide-react"

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
import { numberCodec, stringArrayCodec, useUrlState } from "@/lib/useUrlState"
import { AuthorFitChip, CoiBadge, FieldChip, HumanReviewChip, LLMReviewChip, StatePill, UserCell } from "./Chips"
import { ColumnFilter } from "./ColumnFilter"
import { FieldColumnFilter } from "./FieldColumnFilter"
import { FilterChip, SearchInput } from "./Filters"
import { ProposalSheet } from "./ProposalSheet"

// Toggle a value in/out of a multi-select filter array.
const toggleVal = (arr: string[], v: string) =>
  arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]

const LLM_OPTIONS = [
  {
    value: "accept",
    label: "accept",
    render: <span className="font-medium text-green-700 dark:text-green-400">accept</span>,
  },
  {
    value: "uncertain",
    label: "uncertain",
    render: <span className="font-medium text-amber-700 dark:text-amber-400">uncertain</span>,
  },
  {
    value: "reject",
    label: "reject",
    render: <span className="font-medium text-red-700 dark:text-red-400">reject</span>,
  },
]

// Circle icons matching the Human-review cell chip.
const HUMAN_OPTIONS = [
  {
    value: "approved",
    label: "approved",
    render: (
      <span className="inline-flex items-center gap-1 font-medium text-green-700 dark:text-green-400">
        <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} /> approved
      </span>
    ),
  },
  {
    value: "pending",
    label: "pending",
    render: (
      <span className="inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-400">
        <Clock className="h-3.5 w-3.5" strokeWidth={2} /> pending
      </span>
    ),
  },
  {
    value: "rejected",
    label: "declined",
    render: (
      <span className="inline-flex items-center gap-1 font-medium text-red-700 dark:text-red-400">
        <XCircle className="h-3.5 w-3.5" strokeWidth={2} /> declined
      </span>
    ),
  },
]

// Author-Fit column filter: fit verdicts + a "COI disclosed" option (the column
// also surfaces the blue COI badge).
const FIT_OPTIONS = [
  { value: "direct", label: "direct", render: <span className="font-medium text-green-700 dark:text-green-400">direct</span> },
  { value: "adjacent", label: "adjacent", render: <span className="font-medium text-amber-700 dark:text-amber-400">adjacent</span> },
  { value: "unrelated", label: "unrelated", render: <span className="font-medium text-red-700 dark:text-red-400">unrelated</span> },
  { value: "coi", label: "COI disclosed", render: <span className="font-medium text-blue-700 dark:text-blue-400">COI disclosed</span> },
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
    { value: "closed", label: "Declined", count: counts.closed ?? 0 },
  ]
  // Active highlight matches the state-pill palette: open=amber, approved=green,
  // declined=grey, all=neutral accent.
  const activeTone: Record<string, string> = {
    all: "bg-accent text-accent-foreground",
    open: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    approved: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
    closed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  }
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
                ? activeTone[it.value]
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {it.label}
            <span
              className={cn(
                "font-mono text-[10px]",
                active ? "opacity-70" : "text-muted-foreground/70",
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

// Active sort as a column label + direction detail (for the "Sorted by" chip).
function propSortText(sorting: SortingState): { label: string; detail: string; isDefault: boolean } {
  const s = sorting[0]
  const isDefault = !s || (s.id === "number" && s.desc === true)
  if (!s) return { label: "Order", detail: "newest", isDefault: true }
  let label: string
  let detail: string
  switch (s.id) {
    case "number": label = "Order"; detail = s.desc ? "newest" : "oldest"; break
    case "title": label = "Title"; detail = s.desc ? "Z→A" : "A→Z"; break
    case "updated_days": label = "Updated"; detail = s.desc ? "least recent" : "most recent"; break
    case "age_days": label = "Posted"; detail = s.desc ? "oldest" : "newest"; break
    default: label = s.id; detail = s.desc ? "desc" : "asc"
  }
  return { label, detail, isDefault }
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
    // Newest first — sort by discussion number descending.
    { id: "number", desc: true },
  ])
  // Filters bound to URL query params (p-prefixed so they don't collide with
  // the PRs tab's params). `prop` holds the opened proposal's number.
  const [search, setSearch] = useUrlState("pq", "")
  const [state, setState] = useUrlState<ProposalStateFilter | "all">("pstate", "open")
  const [activeNum, setActiveNum] = useUrlState<number | null>("prop", null, numberCodec)
  const [field, setField] = useUrlState<string[]>("pfield", [], stringArrayCodec)
  const [author, setAuthor] = useUrlState<string[]>("pauthor", [], stringArrayCodec)
  const [reviewer, setReviewer] = useUrlState<string[]>("previewer", [], stringArrayCodec)
  const [llm, setLlm] = useUrlState<string[]>("pllm", [], stringArrayCodec)
  const [fit, setFit] = useUrlState<string[]>("pfit", [], stringArrayCodec)
  const [human, setHuman] = useUrlState<string[]>("phuman", [], stringArrayCodec)
  // Which column's filter popover is open — lifted so it survives the header
  // re-render each multi-select toggle triggers.
  const [openCol, setOpenCol] = useState<string | null>(null)
  const openProps = (id: string) => ({
    open: openCol === id,
    onOpenChange: (v: boolean) => setOpenCol(v ? id : null),
  })
  const active = useMemo(
    () => (activeNum == null ? null : (proposals.find((p) => p.number === activeNum) ?? null)),
    [proposals, activeNum],
  )

  // Derive the 3-way bucket (open / approved / closed) from the underlying
  // `state` + `status` fields.
  const bucketOf = (p: Proposal): ProposalStateFilter => {
    if (p.state === "open") return "open"
    return p.status === "approved" ? "approved" : "closed"
  }

  const stateCounts = useMemo(() => {
    const c: Record<ProposalStateFilter, number> = { open: 0, approved: 0, closed: 0 }
    for (const p of proposals) c[bucketOf(p)] += 1
    return c
  }, [proposals])

  // When the Stats tab forwards filters, apply them and reset state to "all".
  useEffect(() => {
    if (externalField || externalStatus) {
      if (externalField) setField([externalField])
      setHuman(externalStatus ? [externalStatus] : [])
      setState("all")
      onExternalFieldConsumed?.()
    }
  }, [externalField, externalStatus, onExternalFieldConsumed])

  const filtered = useMemo(() => {
    const needle = search.toLowerCase().trim()
    return proposals.filter((p) => {
      if (state !== "all" && bucketOf(p) !== state) return false
      if (field.length) {
        const ok = field.some((f) =>
          f.startsWith("__domain:") ? p.domain === f.slice("__domain:".length) : p.subfield === f,
        )
        if (!ok) return false
      }
      if (author.length && !author.includes(p.author.login)) return false
      if (reviewer.length) {
        const rl = p.reviewer?.login ?? null
        if (!reviewer.some((r) => (r === "__none" ? rl === null : rl === r))) return false
      }
      if (llm.length) {
        const rec = p.llm_review?.recommendation ?? null
        if (!llm.some((l) => (l === "none" ? rec === null : rec === l))) return false
      }
      if (fit.length) {
        const af = p.author_fit ?? null
        if (!fit.some((f) => (f === "coi" ? !!p.coi : af === f))) return false
      }
      if (human.length && !human.includes(p.status)) return false
      if (needle) {
        const hay =
          `${p.number} ${p.proposal_number ?? ""} ${p.title} ${p.author.login} ${p.field ?? ""}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [proposals, search, state, field, author, reviewer, llm, fit, human])

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
  const reviewerOptions = useMemo(() => {
    const c = countBy(stateFiltered, (p) => p.reviewer?.login ?? null)
    const opts = Object.entries(c)
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, label: value, count }))
    // Trailing "unassigned" bucket so those proposals stay filterable.
    const none = stateFiltered.filter((p) => !p.reviewer).length
    if (none) opts.push({ value: "__none", label: "unassigned", count: none })
    return opts
  }, [stateFiltered])

  const columns = useMemo<ColumnDef<Proposal>[]>(
    () => [
      {
        accessorKey: "number",
        header: "#",
        cell: ({ row }) => {
          const p = row.original
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
                {p.number}
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
        size: 400,
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
            onClick={() => setActiveNum(row.original.number)}
            className="text-left font-medium hover:underline underline-offset-4"
          >
            {row.original.title}
          </button>
        ),
      },
      {
        accessorKey: "subfield",
        size: 185,
        header: () => (
          <FieldColumnFilter
            selected={field}
            onToggle={(v) => setField(toggleVal(field, v))}
            onClearAll={() => setField([])}
            counts={fieldCounts}
            {...openProps("field")}
          />
        ),
        cell: ({ row }) => (
          <FieldChip subfield={row.original.subfield} fallback={row.original.field} />
        ),
      },
      {
        accessorKey: "author",
        size: 195,
        header: () => (
          <ColumnFilter
            title="AUTHOR"
            selected={author}
            onToggle={(v) => setAuthor(toggleVal(author, v))}
            onClearAll={() => setAuthor([])}
            options={authorOptions}
            {...openProps("author")}
          />
        ),
        cell: ({ row }) => <UserCell user={row.original.author} />,
      },
      {
        id: "reviewer",
        size: 195,
        header: () => (
          <ColumnFilter
            title="REVIEWER"
            selected={reviewer}
            onToggle={(v) => setReviewer(toggleVal(reviewer, v))}
            onClearAll={() => setReviewer([])}
            options={reviewerOptions}
            {...openProps("reviewer")}
          />
        ),
        cell: ({ row }) => <UserCell user={row.original.reviewer} />,
      },
      {
        id: "author_fit",
        size: 150,
        header: () => (
          <ColumnFilter
            title="AUTHOR FIT"
            selected={fit}
            onToggle={(v) => setFit(toggleVal(fit, v))}
            onClearAll={() => setFit([])}
            options={FIT_OPTIONS}
            {...openProps("fit")}
          />
        ),
        cell: ({ row }) => {
          const p = row.original
          const af = p.author_fit ?? null
          if (!af && !p.coi) {
            return <span className="text-xs text-muted-foreground">—</span>
          }
          return (
            <div className="flex flex-col items-start gap-1">
              <AuthorFitChip fit={af} url={p.llm_review?.url ?? null} />
              {p.coi && <CoiBadge coi={p.coi} />}
            </div>
          )
        },
      },
      {
        accessorKey: "llm_review",
        size: 140,
        header: () => (
          <ColumnFilter
            title="LLM REVIEW"
            selected={llm}
            onToggle={(v) => setLlm(toggleVal(llm, v))}
            onClearAll={() => setLlm([])}
            options={LLM_OPTIONS}
            {...openProps("llm")}
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
            selected={human}
            onToggle={(v) => setHuman(toggleVal(human, v))}
            onClearAll={() => setHuman([])}
            options={HUMAN_OPTIONS}
            {...openProps("human")}
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
    [field, author, reviewer, llm, fit, human, fieldCounts, authorOptions, reviewerOptions, openCol],
  )

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  const anyChip = !!(field.length || author.length || reviewer.length || llm.length || fit.length || human.length)
  const { label: sortLabel, detail: sortDetail, isDefault: isDefaultSort } = propSortText(sorting)

  return (
    <>
    <ProposalSheet
      proposal={active}
      open={active !== null}
      onOpenChange={(v) => !v && setActiveNum(null)}
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

      {/* Active filters + sort — always rendered so activating/clearing one
          doesn't shift the table below (fixed two-row bar). */}
      <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
        <div className="flex items-start gap-2">
          <span className="shrink-0 pt-1 text-xs font-medium text-muted-foreground">Filters:</span>
          <div className="flex flex-wrap items-center gap-2">
            {anyChip ? (
              <>
                {field.length > 0 && (
                  <FilterChip
                    label="Field"
                    value={field
                      .map((f) =>
                        f.startsWith("__domain:")
                          ? `${DOMAIN_LABELS[f.slice("__domain:".length) as Domain] ?? f.slice("__domain:".length)} (other)`
                          : (field_labels[f] ?? f),
                      )
                      .join(", ")}
                    onClear={() => setField([])}
                  />
                )}
                {author.length > 0 && (
                  <FilterChip label="Author" value={author.join(", ")} onClear={() => setAuthor([])} />
                )}
                {fit.length > 0 && (
                  <FilterChip
                    label="Author fit"
                    value={fit.map((f) => FIT_OPTIONS.find((o) => o.value === f)?.label ?? f).join(", ")}
                    onClear={() => setFit([])}
                  />
                )}
                {llm.length > 0 && (
                  <FilterChip
                    label="LLM review"
                    value={llm.map((l) => LLM_OPTIONS.find((o) => o.value === l)?.label ?? l).join(", ")}
                    onClear={() => setLlm([])}
                  />
                )}
                {human.length > 0 && (
                  <FilterChip
                    label="Human review"
                    value={human.map((h) => HUMAN_OPTIONS.find((o) => o.value === h)?.label ?? h).join(", ")}
                    onClear={() => setHuman([])}
                  />
                )}
                <button
                  type="button"
                  className="px-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => {
                    setField([])
                    setAuthor([])
                    setLlm([])
                    setFit([])
                    setHuman([])
                  }}
                >
                  Clear all filters
                </button>
              </>
            ) : (
              <span className="inline-flex shrink-0 items-center rounded-full border bg-background px-2 py-0.5 text-xs text-muted-foreground">
                none
              </span>
            )}
          </div>
        </div>
        <div className="flex items-start gap-2">
          <span className="shrink-0 pt-1 text-xs font-medium text-muted-foreground">Sorted by:</span>
          <div className="flex flex-wrap items-center gap-2">
            {isDefaultSort ? (
              <span className="inline-flex shrink-0 items-center rounded-full border bg-background px-2 py-0.5 text-xs text-muted-foreground">
                newest
              </span>
            ) : (
              <FilterChip
                label={sortLabel}
                value={sortDetail}
                onClear={() => setSorting([{ id: "number", desc: true }])}
              />
            )}
          </div>
        </div>
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

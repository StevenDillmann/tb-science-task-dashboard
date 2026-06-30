import { useEffect, useMemo, useState } from "react"
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table"
import {
  ArrowUpDown,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  ExternalLink,
  XCircle,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { DOMAIN_LABELS, type Domain, type PR, type PRState } from "@/lib/data"
import { useTaxonomy } from "@/lib/taxonomy"
import { cn } from "@/lib/utils"
import {
  BallChip,
  CheatChip,
  CIChip,
  FieldChip,
  RubricChip,
  StageChip,
  StatePill,
  TrialsChip,
  UserCell,
  ReviewersCell,
} from "./Chips"
import { ColumnFilter } from "./ColumnFilter"
import { FieldColumnFilter } from "./FieldColumnFilter"
import { FilterChip, SearchInput } from "./Filters"
import { PRSheet } from "./PRSheet"

// Mirrors StageChip's layout for the filter row: two parallel slots, a gate
// chevron, then the final slot (which stays dimmed until both parallel fill).
function StageMini({ filled }: { filled: 0 | 1 | 2 | 3 }) {
  const parallelFilled = Math.min(filled, 2)
  const finalReached = filled >= 2
  const finalDone = filled >= 3
  const dot = (on: boolean, dim = false) =>
    on ? (
      <Check className="h-3 w-3 text-green-700 dark:text-green-400" strokeWidth={3} />
    ) : (
      <CircleDashed
        className={cn("h-3 w-3", dim ? "text-muted-foreground/50" : "text-muted-foreground")}
        strokeWidth={2}
      />
    )
  return (
    <span className="inline-flex items-center gap-0.5">
      {dot(parallelFilled > 0)}
      {dot(parallelFilled > 1)}
      <ChevronRight
        className={cn(
          "h-3 w-3 shrink-0",
          finalReached ? "text-muted-foreground" : "text-muted-foreground/40",
        )}
        strokeWidth={2}
      />
      {dot(finalDone, !finalReached)}
    </span>
  )
}

const STAGE_OPTIONS = [
  { value: "none", label: "queued", render: <StageMini filled={0} /> },
  { value: "1st", label: "1 approval", render: <StageMini filled={1} /> },
  { value: "2nd", label: "2 approvals", render: <StageMini filled={2} /> },
  { value: "3rd", label: "3 approvals", render: <StageMini filled={3} /> },
]

const BALL_OPTIONS = [
  {
    value: "reviewer",
    label: "reviewer",
    render: (
      <span className="font-medium text-amber-700 dark:text-amber-400">reviewer</span>
    ),
  },
  {
    value: "author",
    label: "author",
    render: (
      <span className="font-medium text-red-700 dark:text-red-400">author</span>
    ),
  },
]

const CI_OPTIONS = [
  {
    value: "success",
    label: "passing",
    render: (
      <CheckCircle2 className="h-4 w-4 text-green-700 dark:text-green-400" />
    ),
  },
  {
    value: "failure",
    label: "failing",
    render: <XCircle className="h-4 w-4 text-red-700 dark:text-red-400" />,
  },
]

/** Pill-shaped All / Open / Merged / Closed switcher — same shape language as
 * the theme toggle, just with text + count instead of icons. */
function StateToggle({
  value,
  onChange,
  counts,
  total,
}: {
  value: PRState | "all"
  onChange: (v: PRState | "all") => void
  counts: Record<PRState, number>
  total: number
}) {
  const items: { value: PRState | "all"; label: string; count: number }[] = [
    { value: "all", label: "All", count: total },
    { value: "open", label: "Open", count: counts.open ?? 0 },
    { value: "merged", label: "Merged", count: counts.merged ?? 0 },
    { value: "closed", label: "Closed", count: counts.closed ?? 0 },
  ]
  // Active highlight matches the state-pill palette: open=amber, merged=green,
  // closed=grey, all=neutral accent.
  const activeTone: Record<string, string> = {
    all: "bg-accent text-accent-foreground",
    open: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    merged: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
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

export function PRsTable({
  prs,
  externalField,
  externalState,
  onExternalFieldConsumed,
}: {
  prs: PR[]
  externalField?: string | null
  externalState?: "open" | "merged" | "closed" | null
  onExternalFieldConsumed?: () => void
}) {
  const { field_labels } = useTaxonomy()
  const [sorting, setSorting] = useState<SortingState>([
    // Newest first — sort by PR number descending. Avoids ties between PRs
    // created on the same day that age_days can't distinguish.
    { id: "number", desc: true },
  ])
  const [search, setSearch] = useState("")
  const [state, setState] = useState<PRState | "all">("open")
  const [active, setActive] = useState<PR | null>(null)
  const [field, setField] = useState<string | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [ball, setBall] = useState<string | null>(null)
  const [author, setAuthor] = useState<string | null>(null)
  const [dri, setDri] = useState<string | null>(null)
  const [ci, setCi] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const needle = search.toLowerCase().trim()
    return prs.filter((p) => {
      if (state !== "all" && p.state !== state) return false
      if (field) {
        // `__domain:<slug>` means "items in this domain with no subfield" (e.g.
        // anything filed under tasks/other/). Plain slug matches by subfield.
        if (field.startsWith("__domain:")) {
          if (p.domain !== field.slice("__domain:".length)) return false
        } else if (p.subfield !== field) return false
      }
      if (stage && p.review_stage !== stage) return false
      if (ball && p.ball_in_court !== ball) return false
      if (author && p.author.login !== author) return false
      if (dri && !p.reviewers.some((d) => d.login === dri)) return false
      if (ci && (p.ci ?? "") !== ci) return false
      if (needle) {
        const hay =
          `${p.number} ${p.title} ${p.author.login} ${p.reviewers.map((d) => d.login).join(" ")} ${p.field ?? ""}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [prs, search, state, field, stage, ball, author, dri, ci])

  // Popover counts respect the active state pill so the dropdown number
  // matches the actual row count after applying that author/field/etc.
  const stateFiltered = useMemo(
    () => (state === "all" ? prs : prs.filter((p) => p.state === state)),
    [prs, state],
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
  const driOptions = useMemo(() => {
    // Count each reviewer's *pending* PRs — i.e. how many are waiting on their
    // action ("to review" load) — so the dropdown surfaces whose turn it is.
    const pending: Record<string, number> = {}
    const total: Record<string, number> = {}
    for (const p of stateFiltered) {
      for (const d of p.reviewers) {
        total[d.login] = (total[d.login] ?? 0) + 1
        if (d.status === "pending") pending[d.login] = (pending[d.login] ?? 0) + 1
      }
    }
    return Object.keys(total)
      .sort((a, b) => (pending[b] ?? 0) - (pending[a] ?? 0) || total[b] - total[a])
      .map((value) => ({ value, label: value, count: pending[value] ?? 0 }))
  }, [stateFiltered])

  const columns = useMemo<ColumnDef<PR>[]>(
    () => [
      {
        accessorKey: "number",
        size: 70,
        header: "#",
        cell: ({ row }) => (
          <span className="inline-flex flex-col items-start gap-1">
            <a
              href={row.original.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:underline"
            >
              {row.original.number}
              <ExternalLink className="h-3 w-3" />
            </a>
            <StatePill tone={row.original.state} label={row.original.state} />
          </span>
        ),
      },
      {
        accessorKey: "title",
        size: 260,
        header: ({ column }) => (
          <button
            className="inline-flex items-center gap-1"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            TITLE <ArrowUpDown className="h-3 w-3" />
          </button>
        ),
        cell: ({ row }) => {
          const fixes = row.original.fixes ?? []
          return (
            <div className="flex flex-col gap-1">
              <button
                type="button"
                onClick={() => setActive(row.original)}
                className="text-left font-medium hover:underline underline-offset-4"
              >
                {row.original.title}
              </button>
              {fixes.length > 0 && (
                <div className="flex flex-col gap-0.5">
                  {fixes.map((f) => (
                    <button
                      key={f.number}
                      type="button"
                      onClick={() => setActive(row.original)}
                      className="self-start font-mono text-[10px] font-semibold uppercase tracking-wider text-blue-700 hover:underline underline-offset-2 dark:text-blue-400"
                      title={`#${f.number} (${f.state}) — ${f.title}`}
                    >
                      fix #{f.number}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        },
      },
      {
        accessorKey: "subfield",
        size: 185,
        header: () => (
          <FieldColumnFilter value={field} onChange={setField} counts={fieldCounts} />
        ),
        cell: ({ row }) => (
          <FieldChip subfield={row.original.subfield} fallback={row.original.field} />
        ),
      },
      {
        accessorKey: "author",
        // Comfortably fits the longest handle (AllenGrahamHart) + avatar.
        size: 195,
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
        accessorKey: "dri",
        // Fits the longest handle (AllenGrahamHart) after the role label +
        // avatar; longer names truncate with an ellipsis (min-w-0 truncate).
        size: 290,
        header: () => (
          <ColumnFilter
            title="REVIEWER"
            value={dri}
            onChange={setDri}
            options={driOptions}
          />
        ),
        cell: ({ row }) => (
          <ReviewersCell
            reviewers={row.original.reviewers}
            onClick={(login) => setDri(dri === login ? null : login)}
            activeLogin={dri}
          />
        ),
      },
      {
        accessorKey: "review_stage",
        size: 90,
        header: () => (
          <ColumnFilter
            title="STAGE"
            value={stage}
            onChange={setStage}
            options={STAGE_OPTIONS}
          />
        ),
        cell: ({ row }) => (
          <StageChip
            stage={row.original.review_stage}
            action={row.original.ball_in_court}
            reviewers={row.original.reviewers}
          />
        ),
      },
      {
        accessorKey: "ball_in_court",
        size: 90,
        header: () => (
          <ColumnFilter
            title="ACTION"
            value={ball}
            onChange={setBall}
            options={BALL_OPTIONS}
          />
        ),
        cell: ({ row }) => (
          <BallChip
            ball={row.original.ball_in_court}
            stage={row.original.review_stage}
            state={row.original.state}
          />
        ),
      },
      {
        accessorKey: "ci",
        size: 60,
        header: () => (
          <ColumnFilter title="CI" value={ci} onChange={setCi} options={CI_OPTIONS} />
        ),
        cell: ({ row }) => <CIChip ci={row.original.ci} />,
      },
      {
        accessorKey: "rubric",
        size: 90,
        header: "RUBRIC",
        cell: ({ row }) => <RubricChip rubric={row.original.rubric} />,
      },
      {
        accessorKey: "trials",
        size: 170,
        header: () => <span className="whitespace-nowrap">FRONTIER TRIALS</span>,
        cell: ({ row }) => <TrialsChip trials={row.original.trials} />,
      },
      {
        accessorKey: "cheat",
        size: 140,
        header: () => <span className="whitespace-nowrap">CHEAT TRIALS</span>,
        cell: ({ row }) => <CheatChip cheat={row.original.cheat} />,
      },
      {
        accessorKey: "linked_proposal",
        size: 100,
        header: "PROPOSAL",
        cell: ({ row }) => {
          const lp = row.original.linked_proposal
          if (!lp) return <span className="text-xs text-muted-foreground">—</span>
          const label = lp.proposal_number !== null ? `#${lp.proposal_number}` : `#d${lp.discussion_number}`
          return (
            <a
              href={lp.url}
              target="_blank"
              rel="noreferrer"
              title={lp.title}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              {label}
              <ExternalLink className="h-3 w-3" />
            </a>
          )
        },
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
          return <span className="text-muted-foreground">{d === 0 ? "today" : `${d}d`}</span>
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
    [field, stage, ball, dri, author, ci, fieldCounts, driOptions, authorOptions],
  )

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  const anyFilter = !!(search || field || stage || ball || dri || author || ci)

  // Per-state totals (ignoring other filters) drive the toggle counts so the
  // numbers stay stable as you select inside a state.
  const stateCounts = useMemo(() => {
    const c: Record<PRState, number> = { open: 0, closed: 0, merged: 0 }
    for (const p of prs) c[p.state] = (c[p.state] ?? 0) + 1
    return c
  }, [prs])

  // Receive filters from Stats and apply them.
  useEffect(() => {
    if (externalField || externalState) {
      if (externalField) setField(externalField)
      setState(externalState ?? "all")
      onExternalFieldConsumed?.()
    }
  }, [externalField, externalState, onExternalFieldConsumed])

  return (
    <>
    <PRSheet
      pr={active}
      open={active !== null}
      onOpenChange={(v) => !v && setActive(null)}
    />
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-3">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search"
          className="max-w-sm"
        />
        <StateToggle value={state} onChange={setState} counts={stateCounts} total={prs.length} />
        {anyFilter && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            onClick={() => {
              setSearch("")
              setField(null)
              setStage(null)
              setBall(null)
              setAuthor(null)
              setDri(null)
              setCi(null)
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
        {stage && (
          <FilterChip
            label="Stage"
            value={STAGE_OPTIONS.find((o) => o.value === stage)?.label ?? stage}
            onClear={() => setStage(null)}
          />
        )}
        {ball && (
          <FilterChip label="Action" value={ball} onClear={() => setBall(null)} />
        )}
        {dri && <FilterChip label="Reviewer" value={dri} onClear={() => setDri(null)} />}
        {author && (
          <FilterChip label="Author" value={author} onClear={() => setAuthor(null)} />
        )}
        {ci && (
          <FilterChip
            label="CI"
            value={CI_OPTIONS.find((o) => o.value === ci)?.label ?? ci}
            onClear={() => setCi(null)}
          />
        )}
        <span className="text-xs text-muted-foreground">
          {filtered.length} {filtered.length === 1 ? "row" : "rows"}
        </span>
        <a
          href="https://github.com/harbor-framework/terminal-bench-science/blob/main/CONTRIBUTING.md"
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background transition-opacity hover:opacity-90"
        >
          <BookOpen className="h-3.5 w-3.5" />
          Contributing guide
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
                  No task pull requests match these filters.
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

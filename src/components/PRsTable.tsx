import { useMemo, useState } from "react"
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
  TrialsChip,
  UserCell,
} from "./Chips"
import { ColumnFilter } from "./ColumnFilter"
import { FieldColumnFilter } from "./FieldColumnFilter"
import { FilterChip, SearchInput } from "./Filters"

function StageMini({ filled }: { filled: 0 | 1 | 2 | 3 }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[0, 1, 2].map((i) =>
        i < filled ? (
          <Check
            key={i}
            className="h-3 w-3 text-green-700 dark:text-green-400"
            strokeWidth={3}
          />
        ) : (
          <CircleDashed
            key={i}
            className="h-3 w-3 text-muted-foreground"
            strokeWidth={2}
          />
        ),
      )}
    </span>
  )
}

const STAGE_OPTIONS = [
  { value: "none", label: "queued", render: <StageMini filled={0} /> },
  { value: "1st", label: "1st pass", render: <StageMini filled={1} /> },
  { value: "2nd", label: "2nd pass", render: <StageMini filled={2} /> },
  { value: "3rd", label: "3rd pass", render: <StageMini filled={3} /> },
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

export function PRsTable({ prs }: { prs: PR[] }) {
  const { field_labels } = useTaxonomy()
  const [sorting, setSorting] = useState<SortingState>([
    // Newest first — sort by PR number descending. Avoids ties between PRs
    // created on the same day that age_days can't distinguish.
    { id: "number", desc: true },
  ])
  const [search, setSearch] = useState("")
  const [state, setState] = useState<PRState | "all">("all")
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
      if (dri && p.dri?.login !== dri) return false
      if (ci && (p.ci ?? "") !== ci) return false
      if (needle) {
        const hay =
          `${p.title} ${p.author.login} ${p.dri?.login ?? ""} ${p.field ?? ""}`.toLowerCase()
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
    const c = countBy(stateFiltered, (p) => p.dri?.login ?? null)
    return Object.entries(c)
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, label: value, count }))
  }, [stateFiltered])

  const columns = useMemo<ColumnDef<PR>[]>(
    () => [
      {
        accessorKey: "number",
        size: 70,
        header: "#",
        cell: ({ row }) => (
          <a
            href={row.original.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:underline"
          >
            {row.original.number}
            <ExternalLink className="h-3 w-3" />
          </a>
        ),
      },
      {
        accessorKey: "title",
        size: 340,
        header: ({ column }) => (
          <button
            className="inline-flex items-center gap-1"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            TITLE <ArrowUpDown className="h-3 w-3" />
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
        accessorKey: "dri",
        size: 180,
        header: () => (
          <ColumnFilter
            title="REVIEWER"
            value={dri}
            onChange={setDri}
            options={driOptions}
          />
        ),
        cell: ({ row }) => <UserCell user={row.original.dri} />,
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
          />
        ),
      },
      {
        accessorKey: "ball_in_court",
        size: 100,
        header: () => (
          <ColumnFilter
            title="ACTION"
            value={ball}
            onChange={setBall}
            options={BALL_OPTIONS}
          />
        ),
        cell: ({ row }) => <BallChip ball={row.original.ball_in_court} />,
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
        header: "FRONTIER TRIALS",
        cell: ({ row }) => <TrialsChip trials={row.original.trials} />,
      },
      {
        accessorKey: "cheat",
        size: 100,
        header: "CHEAT",
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

  return (
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
  )
}

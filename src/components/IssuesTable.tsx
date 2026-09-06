import { useEffect, useMemo, useState } from "react"
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table"
import { ArrowUpDown, CircleDot, ExternalLink } from "lucide-react"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { DOMAIN_LABELS, type Domain, type Issue, type IssueKind } from "@/lib/data"
import { useTaxonomy } from "@/lib/taxonomy"
import { cn } from "@/lib/utils"
import { numberCodec, stringArrayCodec, useUrlState } from "@/lib/useUrlState"
import { FieldChip, HumanReviewChip, IssueStatePill, UserCell } from "./Chips"
import { ColumnFilter } from "./ColumnFilter"
import { FieldColumnFilter } from "./FieldColumnFilter"
import { FilterChip, SearchInput } from "./Filters"
import { IssueSheet } from "./IssueSheet"

const UPSTREAM = "harbor-framework/terminal-bench-science"
const NEW_ISSUE_URL = `https://github.com/${UPSTREAM}/issues/new?template=task-fix.yml`

const toggleVal = (arr: string[], v: string) =>
  arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]

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

// `task fix` = filed through the form (routed automatically); `task` = about a
// task but free-form; `infra` = CI/workflow/tooling/docs. Same small outlined
// mono chip as the PRs tab's tags — a facet, not a status.
const KIND_STYLE: Record<IssueKind, string> = {
  "task fix": "border-amber-600/50 text-amber-700 dark:border-amber-400/50 dark:text-amber-400",
  task: "border-sky-600/50 text-sky-700 dark:border-sky-400/50 dark:text-sky-400",
  // Neutral on purpose: infra is the "everything else" bucket, so the one
  // type reviewers must notice (task fix) is the one that carries colour.
  // Blue is Earth Sciences / COI and purple is the gpu tag, so neither is free.
  infra: "border-muted-foreground/40 text-muted-foreground",
}
const KIND_TITLE: Record<IssueKind, string> = {
  "task fix": "Filed through the Task fix request form",
  task: "About a merged task, filed without the form",
  infra: "Infrastructure, workflows, tooling or docs",
}

export function KindChip({ kind }: { kind: IssueKind }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-sm border px-1 py-px font-mono text-[10px] font-semibold uppercase leading-none tracking-wider",
        KIND_STYLE[kind],
      )}
      title={KIND_TITLE[kind]}
    >
      {kind}
    </span>
  )
}

const KIND_OPTIONS = (["task fix", "task", "infra"] as IssueKind[]).map((k) => ({
  value: k,
  label: k,
  render: <KindChip kind={k} />,
}))

const TITLE_SORT_OPTIONS = [
  { value: "title:asc", label: "A→Z" },
  { value: "title:desc", label: "Z→A" },
]

// The form's Category dropdown, shortened for a table cell. Free-form issues
// have none.
const CATEGORY_SHORT: Record<string, string> = {
  "Instruction (ambiguous, wrong, or underspecified)": "Instruction",
  "Verifier / tests (wrong assertions, doesn't match instruction)": "Verifier / tests",
  "Solution / oracle (doesn't solve the task)": "Solution / oracle",
  "Environment / Dockerfile (missing deps, leaks solution or tests)": "Environment",
  "Flaky / nondeterministic": "Flaky",
  "Cheatable (shortcut lets an agent pass without the intended work)": "Cheatable",
  "Dataset / input files": "Dataset",
  Other: "Other",
}
const shortCategory = (c: string | null) => (c ? (CATEGORY_SHORT[c] ?? c) : null)

type StateFilter = "open" | "closed"

/** Same pill as the PRs tab, minus the merged bucket issues don't have. */
function StateToggle({
  value,
  onChange,
  counts,
  total,
}: {
  value: StateFilter | "all"
  onChange: (v: StateFilter | "all") => void
  counts: Record<StateFilter, number>
  total: number
}) {
  const items: { value: StateFilter | "all"; label: string; count: number }[] = [
    { value: "all", label: "All", count: total },
    { value: "open", label: "Open", count: counts.open },
    { value: "closed", label: "Closed", count: counts.closed },
  ]
  const activeTone: Record<string, string> = {
    all: "bg-accent text-accent-foreground",
    open: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    closed: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
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
              active ? activeTone[it.value] : "text-muted-foreground hover:text-foreground",
            )}
          >
            {it.label}
            <span className={cn("font-mono text-[10px]", active ? "opacity-70" : "text-muted-foreground/70")}>
              {it.count}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function sortText(sorting: SortingState): { label: string; detail: string; isDefault: boolean } {
  const s = sorting[0]
  if (!s) return { label: "Order", detail: "newest", isDefault: true }
  const isDefault = s.id === "number" && s.desc
  switch (s.id) {
    case "number": return { label: "Order", detail: s.desc ? "newest" : "oldest", isDefault }
    case "title": return { label: "Title", detail: s.desc ? "Z→A" : "A→Z", isDefault }
    case "task": return { label: "Task", detail: s.desc ? "Z→A" : "A→Z", isDefault }
    case "posted": return { label: "Posted", detail: s.desc ? "oldest" : "newest", isDefault }
    default: return { label: s.id, detail: s.desc ? "desc" : "asc", isDefault }
  }
}

/** Every upstream issue — problems reported against merged tasks (through the
 *  fix-request form or free-form) plus infra. Mirrors the PRs tab: state pill,
 *  fixed filter/sort bar, click-to-filter columns, row click opens a sheet. */
export function IssuesTable({
  issues,
  externalField,
  onExternalFieldConsumed,
}: {
  issues: Issue[]
  externalField?: string | null
  onExternalFieldConsumed?: () => void
}) {
  const { field_labels } = useTaxonomy()
  const [sorting, setSorting] = useState<SortingState>([{ id: "number", desc: true }])
  // URL params prefixed `i` so they don't collide with the other tabs.
  const [search, setSearch] = useUrlState("iq", "")
  const [state, setState] = useUrlState<StateFilter | "all">("istate", "open")
  const [activeNum, setActiveNum] = useUrlState<number | null>("issue", null, numberCodec)
  const [kind, setKind] = useUrlState<string[]>("ikind", [], stringArrayCodec)
  const [field, setField] = useUrlState<string[]>("ifield", [], stringArrayCodec)
  const [category, setCategory] = useUrlState<string[]>("icat", [], stringArrayCodec)
  const [author, setAuthor] = useUrlState<string[]>("iauthor", [], stringArrayCodec)
  const [assignee, setAssignee] = useUrlState<string[]>("iassignee", [], stringArrayCodec)
  const [openCol, setOpenCol] = useState<string | null>(null)
  const openProps = (id: string) => ({
    open: openCol === id,
    onOpenChange: (v: boolean) => setOpenCol(v ? id : null),
  })
  const active = useMemo(
    () => (activeNum == null ? null : (issues.find((i) => i.number === activeNum) ?? null)),
    [issues, activeNum],
  )

  useEffect(() => {
    if (externalField) {
      setField([externalField])
      setState("all")
      onExternalFieldConsumed?.()
    }
  }, [externalField, onExternalFieldConsumed])

  const stateCounts = useMemo(() => {
    const c: Record<StateFilter, number> = { open: 0, closed: 0 }
    for (const i of issues) c[i.state] += 1
    return c
  }, [issues])

  const filtered = useMemo(() => {
    const needle = search.toLowerCase().trim()
    return issues.filter((i) => {
      if (state !== "all" && i.state !== state) return false
      if (kind.length && !kind.includes(i.kind)) return false
      if (field.length) {
        const ok = field.some((f) =>
          f.startsWith("__domain:") ? i.domain === f.slice("__domain:".length) : i.subfield === f,
        )
        if (!ok) return false
      }
      if (category.length && !category.includes(shortCategory(i.category) ?? "__none")) return false
      if (author.length && !author.includes(i.author.login)) return false
      if (assignee.length) {
        const logins = i.assignees.map((a) => a.login)
        if (!assignee.some((a) => (a === "__none" ? logins.length === 0 : logins.includes(a)))) return false
      }
      if (needle) {
        const hay = [
          i.number,
          i.title,
          i.kind,
          i.slug ?? "",
          i.task_dir ?? "",
          i.category ?? "",
          i.author.login,
          ...i.assignees.map((a) => a.login),
          ...i.linked_prs.map((p) => p.number),
          ...i.labels,
        ]
          .join(" ")
          .toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [issues, search, state, kind, field, category, author, assignee])

  // Column-filter counts follow the state pill only, so picking one value never
  // hides the others.
  const stateFiltered = useMemo(
    () => (state === "all" ? issues : issues.filter((i) => i.state === state)),
    [issues, state],
  )
  const kindOptions = useMemo(() => {
    const c = countBy(stateFiltered, (i) => i.kind)
    return KIND_OPTIONS.map((o) => ({ ...o, count: c[o.value] ?? 0 })).filter((o) => o.count > 0)
  }, [stateFiltered])
  const fieldCounts = useMemo(() => {
    const c = countBy(stateFiltered, (i) => i.subfield)
    for (const i of stateFiltered) {
      if (!i.subfield && i.domain) {
        const k = `__domain:${i.domain}`
        c[k] = (c[k] ?? 0) + 1
      }
    }
    return c
  }, [stateFiltered])
  const categoryOptions = useMemo(() => {
    const c = countBy(stateFiltered, (i) => shortCategory(i.category) ?? "__none")
    return Object.entries(c)
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, label: value === "__none" ? "none (free-form)" : value, count }))
  }, [stateFiltered])
  const authorOptions = useMemo(() => {
    const c = countBy(stateFiltered, (i) => i.author.login)
    return Object.entries(c)
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, label: value, count }))
  }, [stateFiltered])
  const assigneeOptions = useMemo(() => {
    const c: Record<string, number> = {}
    for (const i of stateFiltered) for (const a of i.assignees) c[a.login] = (c[a.login] ?? 0) + 1
    const opts = Object.entries(c)
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, label: value, count }))
    const none = stateFiltered.filter((i) => !i.assignees.length).length
    if (none) opts.push({ value: "__none", label: "unassigned", count: none })
    return opts
  }, [stateFiltered])

  const columns = useMemo<ColumnDef<Issue>[]>(
    () => [
      {
        accessorKey: "number",
        header: "#",
        // Wider than the PRs tab's 70: "not planned" is the longest state pill.
        size: 85,
        cell: ({ row }) => {
          const i = row.original
          return (
            <span className="inline-flex flex-col items-start gap-1">
              <a
                href={i.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:underline"
              >
                {i.number}
                <ExternalLink className="h-3 w-3" />
              </a>
              <IssueStatePill state={i.state} reason={i.state_reason} />
            </span>
          )
        },
      },
      {
        accessorKey: "title",
        size: 265,
        // The Type facet hangs off this header, the way Tags does on the PRs
        // tab: the chip lives in the cell, the filter in the header.
        header: () => {
          const cur = sorting[0]?.id === "title" ? sorting[0] : null
          return (
            <ColumnFilter
              title="TITLE"
              heading="Type"
              options={kindOptions}
              selected={kind}
              onToggle={(v) => setKind(toggleVal(kind, v))}
              onClearAll={() => setKind([])}
              sortOptions={TITLE_SORT_OPTIONS}
              sortValue={cur ? `title:${cur.desc ? "desc" : "asc"}` : null}
              onSortChange={(v) =>
                setSorting(v ? [{ id: "title", desc: v.endsWith(":desc") }] : [{ id: "number", desc: true }])
              }
              {...openProps("title")}
            />
          )
        },
        cell: ({ row }) => {
          const i = row.original
          return (
            <div className="flex flex-col gap-1">
              <span className="font-medium">{i.title}</span>
              <span className="flex flex-wrap gap-1">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setKind(toggleVal(kind, i.kind))
                  }}
                  className={cn("rounded-sm", kind.includes(i.kind) && "ring-2 ring-offset-1 ring-foreground/30")}
                  title={kind.includes(i.kind) ? "Click to clear filter" : "Click to filter by this type"}
                >
                  <KindChip kind={i.kind} />
                </button>
              </span>
            </div>
          )
        },
      },
      {
        accessorKey: "subfield",
        size: 160,
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
          <FieldChip
            subfield={row.original.subfield}
            fallback={null}
            onClick={() => row.original.subfield && setField(toggleVal(field, row.original.subfield))}
            active={!!row.original.subfield && field.includes(row.original.subfield)}
          />
        ),
      },
      {
        id: "author",
        // Same as the PRs tab — fits the longest handle (AllenGrahamHart).
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
        cell: ({ row }) => (
          <UserCell
            user={row.original.author}
            onClick={() => setAuthor(toggleVal(author, row.original.author.login))}
            active={author.includes(row.original.author.login)}
          />
        ),
      },
      {
        id: "assignees",
        // Same as the PRs tab's REVIEWER: role label + avatar + longest handle.
        size: 280,
        header: () => (
          <ColumnFilter
            title="REVIEWER"
            selected={assignee}
            onToggle={(v) => setAssignee(toggleVal(assignee, v))}
            onClearAll={() => setAssignee([])}
            options={assigneeOptions}
            {...openProps("assignee")}
          />
        ),
        cell: ({ row }) => {
          const i = row.original
          if (!i.assignees.length) return <span className="text-muted-foreground">—</span>
          const anyRole = i.assignees.some((a) => a.role)
          return (
            <span className="flex min-w-0 flex-col gap-0.5">
              {i.assignees.map((a) => (
                <UserCell
                  key={a.login}
                  user={a}
                  role={a.role}
                  reserveRole={anyRole}
                  onClick={() => setAssignee(toggleVal(assignee, a.login))}
                  active={assignee.includes(a.login)}
                />
              ))}
            </span>
          )
        },
      },
      {
        id: "task",
        accessorFn: (i) => i.slug ?? "",
        size: 140,
        header: ({ column }) => (
          <button
            className="inline-flex items-center gap-1"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            TASK <ArrowUpDown className="h-3 w-3" />
          </button>
        ),
        cell: ({ row }) => {
          const i = row.original
          if (!i.slug) return <span className="text-muted-foreground">—</span>
          return i.task_dir ? (
            <a
              href={`https://github.com/${UPSTREAM}/tree/main/${i.task_dir}`}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              title={i.task_dir}
              className="inline-flex max-w-full items-center gap-1 font-mono text-xs hover:underline"
            >
              <span className="truncate">{i.slug}</span>
              <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
            </a>
          ) : (
            <span className="truncate font-mono text-xs" title="Not found on main">{i.slug}</span>
          )
        },
      },
      {
        id: "category",
        size: 115,
        header: () => (
          <ColumnFilter
            title="CATEGORY"
            selected={category}
            onToggle={(v) => setCategory(toggleVal(category, v))}
            onClearAll={() => setCategory([])}
            options={categoryOptions}
            {...openProps("category")}
          />
        ),
        cell: ({ row }) => {
          const c = shortCategory(row.original.category)
          return c ? (
            <span className="text-xs" title={row.original.category ?? undefined}>{c}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )
        },
      },
      {
        id: "linked",
        size: 135,
        header: () => (
          <span title="Pull requests that reference this issue — for a task fix, the repair PR">
            LINKED PR
          </span>
        ),
        // Same shape as the PRs tab's PROPOSAL cell: mono #number link plus a
        // compact status glyph (merged ✓ · open ◌ · closed ✗).
        cell: ({ row }) => {
          const prs = row.original.linked_prs
          if (!prs.length) return <span className="text-xs text-muted-foreground">—</span>
          return (
            <span className="flex flex-col gap-0.5">
              {prs.map((p) => (
                <span key={p.number} className="inline-flex items-center gap-1.5">
                  <a
                    href={p.url ?? `https://github.com/${UPSTREAM}/pull/${p.number}`}
                    target="_blank"
                    rel="noreferrer"
                    title={`PR #${p.number} · ${p.state}`}
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
                  >
                    #{p.number}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                  <HumanReviewChip
                    status={p.state === "merged" ? "approved" : p.state === "open" ? "pending" : "rejected"}
                    compact
                  />
                </span>
              ))}
            </span>
          )
        },
      },
      {
        id: "posted",
        accessorKey: "age_days",
        size: 90,
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
          <span className="text-muted-foreground" title={`${row.original.age_days} days ago`}>
            {formatPostedDate(row.original.created_at)}
          </span>
        ),
      },
    ],
    [sorting, kind, kindOptions, field, fieldCounts, category, categoryOptions, author, authorOptions, assignee, assigneeOptions, openCol],
  )

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  const sortInfo = sortText(sorting)
  const anyChip = kind.length || field.length || category.length || author.length || assignee.length
  const rows = table.getRowModel().rows

  return (
    <>
    <IssueSheet issue={active} open={active !== null} onOpenChange={(v) => !v && setActiveNum(null)} />
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search" className="max-w-sm" />
        <StateToggle value={state} onChange={setState} counts={stateCounts} total={issues.length} />
        <span className="text-xs text-muted-foreground">
          {rows.length} {rows.length === 1 ? "row" : "rows"}
        </span>
        <a
          href={NEW_ISSUE_URL}
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background transition-opacity hover:opacity-90"
          title="Report a problem with a merged task"
        >
          <CircleDot className="h-3.5 w-3.5" />
          Report a task issue
        </a>
      </div>

      {/* Fixed two-row bar, like the PRs tab, so toggling a filter never
          shifts the table. */}
      <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
        <div className="flex items-start gap-2">
          <span className="shrink-0 pt-1 text-xs font-medium text-muted-foreground">Filters:</span>
          <div className="flex flex-wrap items-center gap-2">
            {anyChip ? (
              <>
                {kind.length > 0 && <FilterChip label="Type" value={kind.join(", ")} onClear={() => setKind([])} />}
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
                {category.length > 0 && (
                  <FilterChip
                    label="Category"
                    value={category.map((c) => (c === "__none" ? "none" : c)).join(", ")}
                    onClear={() => setCategory([])}
                  />
                )}
                {author.length > 0 && <FilterChip label="Author" value={author.join(", ")} onClear={() => setAuthor([])} />}
                {assignee.length > 0 && (
                  <FilterChip
                    label="Reviewer"
                    value={assignee.map((a) => (a === "__none" ? "unassigned" : a)).join(", ")}
                    onClear={() => setAssignee([])}
                  />
                )}
                <button
                  type="button"
                  className="px-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => {
                    setKind([])
                    setField([])
                    setCategory([])
                    setAuthor([])
                    setAssignee([])
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
            {sortInfo.isDefault ? (
              <span className="inline-flex shrink-0 items-center rounded-full border bg-background px-2 py-0.5 text-xs text-muted-foreground">
                newest
              </span>
            ) : (
              <FilterChip
                label={sortInfo.label}
                value={sortInfo.detail}
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
                    {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                  {issues.length === 0 ? "No issues." : "No issues match."}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow
                  key={row.id}
                  className={cn("cursor-pointer", row.original.number === activeNum && "bg-accent/40")}
                  onClick={() => setActiveNum(row.original.number)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="align-top">
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

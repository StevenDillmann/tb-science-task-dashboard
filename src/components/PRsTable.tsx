import { Fragment, useEffect, useMemo, useState } from "react"
import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ExpandedState,
  type SortingState,
} from "@tanstack/react-table"
import {
  ArrowUpDown,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Clock,
  ExternalLink,
  Pen,
  Search,
  XCircle,
} from "lucide-react"

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
import { cn, formatExactDateTime, formatRelativeTime } from "@/lib/utils"
import { searchableLabels, tagLabels } from "@/lib/labels"
import { numberCodec, stringArrayCodec, useUrlState } from "@/lib/useUrlState"
import {
  AuthorFitChip,
  BallChip,
  CheatChip,
  CIChip,
  CoiBadge,
  CostTimeChip,
  FieldChip,
  HumanReviewChip,
  RubricChip,
  StageChip,
  StatePill,
  TagChip,
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
      <CheckCircle2 className="h-3 w-3 text-green-700 dark:text-green-400" strokeWidth={2} />
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

// Match the Action cell: muted uppercase role tag + icon (Gavel = reviewer,
// SquarePen = author).
const BALL_TAG = "inline-flex items-center gap-1 text-[10px] font-medium tracking-wider text-muted-foreground uppercase"
const BALL_OPTIONS = [
  {
    value: "reviewer",
    label: "reviewer",
    render: (
      <span className={BALL_TAG}>
        <Search className="h-3 w-3" />
        reviewer
      </span>
    ),
  },
  {
    value: "author",
    label: "author",
    render: (
      <span className={BALL_TAG}>
        <Pen className="h-3 w-3" />
        author
      </span>
    ),
  },
]

// Sort choices for the Frontier Trials column (pass rate / avg cost / runtime).
// The oracle runs once and reports no cost, so pass rate is the only axis
// worth sorting it by.
const ORACLE_SORT_OPTIONS = [
  { value: "pass:desc", label: "oracle pass (high → low)" },
  { value: "pass:asc", label: "oracle pass (low → high)" },
]

const TRIAL_SORT_OPTIONS = [
  { value: "pass:desc", label: "pass rate (high → low)" },
  { value: "pass:asc", label: "pass rate (low → high)" },
  { value: "time:desc", label: "runtime (high → low)" },
  { value: "time:asc", label: "runtime (low → high)" },
  { value: "cost:desc", label: "cost (high → low)" },
  { value: "cost:asc", label: "cost (low → high)" },
]

// Sort choices for the Cheat Trials column (success rate / avg cost / runtime).
const CHEAT_SORT_OPTIONS = [
  { value: "success:desc", label: "cheat rate (high → low)" },
  { value: "success:asc", label: "cheat rate (low → high)" },
  { value: "time:desc", label: "runtime (high → low)" },
  { value: "time:asc", label: "runtime (low → high)" },
  { value: "cost:desc", label: "cost (high → low)" },
  { value: "cost:asc", label: "cost (low → high)" },
]

// Toggle a value in/out of a multi-select filter array.
const toggleVal = (arr: string[], v: string) =>
  arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]

// Active sort as a column label + direction detail (for the "Sorted by" chip,
// styled like the filter chips: "Column: detail").
function prSortText(
  sorting: SortingState,
  trialMetric: string | null,
  cheatMetric: string | null,
): { label: string; detail: string; isDefault: boolean } {
  const s = sorting[0]
  const isDefault = !s || (s.id === "number" && s.desc === true)
  if (!s) return { label: "Order", detail: "newest", isDefault: true }
  const dir = s.desc ? "high→low" : "low→high"
  const metricWord = (m: string | null) =>
    m === "pass"
      ? "pass rate"
      : m === "success"
        ? "cheat rate"
        : m === "time"
          ? "runtime"
          : m === "cost"
            ? "cost"
            : "trials"
  let label: string
  let detail: string
  switch (s.id) {
    case "number": label = "Order"; detail = s.desc ? "newest" : "oldest"; break
    case "title": label = "Title"; detail = s.desc ? "Z→A" : "A→Z"; break
    case "age_days": label = "Posted"; detail = s.desc ? "oldest" : "newest"; break
    case "updated_days": label = "Updated"; detail = s.desc ? "least recent" : "most recent"; break
    case "ball_in_court": label = "Action"; detail = s.desc ? "longest waiting" : "shortest waiting"; break
    case "trials": label = "Frontier trials"; detail = `${metricWord(trialMetric)} (${dir})`; break
    case "cheat": label = "Cheat trials"; detail = `${metricWord(cheatMetric)} (${dir})`; break
    default: label = s.id; detail = dir
  }
  return { label, detail, isDefault }
}

// Sort choices for the Task column (alphabetical by title).
const TITLE_SORT_OPTIONS = [
  { value: "title:asc", label: "title (A → Z)" },
  { value: "title:desc", label: "title (Z → A)" },
]

// Sort choices for the Action column (how long it's waited in its state).
const ACTION_SORT_OPTIONS = [
  { value: "wait:desc", label: "longest waiting first" },
  { value: "wait:asc", label: "shortest waiting first" },
]

// Filter the PROPOSAL column by the linked proposal's review status.
const PROPOSAL_STATUS_OPTIONS = [
  {
    value: "approved",
    label: "approved",
    render: (
      <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-400">
        <Check className="h-3 w-3" strokeWidth={3} /> approved
      </span>
    ),
  },
  {
    value: "pending",
    label: "pending",
    render: (
      <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
        <Clock className="h-3 w-3" /> pending
      </span>
    ),
  },
  {
    value: "rejected",
    label: "declined",
    render: (
      <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-400">
        <XCircle className="h-3 w-3" /> declined
      </span>
    ),
  },
  {
    value: "none",
    label: "no proposal",
    render: <span className="text-muted-foreground">no proposal</span>,
  },
]

// Author-Fit column filter: the fit verdicts plus a "COI disclosed" option
// (the column also surfaces the blue COI badge).
const FIT_FILTER_OPTIONS = [
  { value: "direct", label: "direct", render: <span className="font-medium text-green-700 dark:text-green-400">direct</span> },
  { value: "adjacent", label: "adjacent", render: <span className="font-medium text-amber-700 dark:text-amber-400">adjacent</span> },
  { value: "unrelated", label: "unrelated", render: <span className="font-medium text-red-700 dark:text-red-400">unrelated</span> },
  { value: "coi", label: "COI disclosed", render: <span className="font-medium text-blue-700 dark:text-blue-400">COI disclosed</span> },
]

const CI_OPTIONS = [
  {
    value: "success",
    label: "passing",
    render: (
      <span className="inline-flex items-center gap-1.5 text-green-700 dark:text-green-400">
        <CheckCircle2 className="h-4 w-4" /> passing
      </span>
    ),
  },
  {
    value: "failure",
    label: "failing",
    render: (
      <span className="inline-flex items-center gap-1.5 text-red-700 dark:text-red-400">
        <XCircle className="h-4 w-4" /> failing
      </span>
    ),
  },
  {
    value: "pending",
    label: "pending",
    render: (
      <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
        <Clock className="h-4 w-4" /> pending
      </span>
    ),
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
  // Which trial metric the Frontier Trials column sorts by (cost or runtime);
  // null = not sorting on trials. Direction lives in `sorting` (id "trials").
  const [trialMetric, setTrialMetric] = useState<"cost" | "time" | "pass" | null>(null)
  // Same, for the Cheat Trials column (success rate / cost / runtime).
  const [cheatMetric, setCheatMetric] = useState<"cost" | "time" | "success" | null>(null)
  // Which column's filter popover is open — lifted here so it survives the
  // header re-render that each multi-select toggle triggers (otherwise the
  // popover would snap shut after every pick).
  const [openCol, setOpenCol] = useState<string | null>(null)
  const openProps = (id: string) => ({
    open: openCol === id,
    onOpenChange: (v: boolean) => setOpenCol(v ? id : null),
  })
  // Filters are bound to URL query params so a filtered view is shareable and
  // survives reload / back-forward. `pr` holds the opened PR's number.
  const [search, setSearch] = useUrlState("q", "")
  const [state, setState] = useUrlState<PRState | "all">("state", "open")
  const [activeNum, setActiveNum] = useUrlState<number | null>("pr", null, numberCodec)
  // Multi-select filters (OR within a column); `ball` (Action) stays single.
  const [field, setField] = useUrlState<string[]>("field", [], stringArrayCodec)
  const [stage, setStage] = useUrlState<string[]>("stage", [], stringArrayCodec)
  const [ball, setBall] = useUrlState<string | null>("ball", null)
  const [author, setAuthor] = useUrlState<string[]>("author", [], stringArrayCodec)
  const [dri, setDri] = useUrlState<string[]>("dri", [], stringArrayCodec)
  const [ci, setCi] = useUrlState<string[]>("ci", [], stringArrayCodec)
  // Filter by the linked proposal's review status (or "none" = no linked proposal).
  const [propStatus, setPropStatus] = useUrlState<string[]>("prop_status", [], stringArrayCodec)
  // Author-fit filter: fit verdicts + "coi" (COI disclosed).
  const [fit, setFit] = useUrlState<string[]>("fit", [], stringArrayCodec)
  // Tags: the upstream labels no other column models (`gpu`, `lite`, …). Lives
  // on the Task column, since that's where the chips render.
  const [tags, setTags] = useUrlState<string[]>("tags", [], stringArrayCodec)
  // Which task rows have their fix subrows open. Deliberately NOT in the URL:
  // it's a transient reading gesture, not a view worth sharing.
  const [expanded, setExpanded] = useState<ExpandedState>({})
  // The opened PR, resolved from its number in the URL (looked up in the full
  // list so a deep link opens the panel regardless of the active filters). Fix
  // PRs live inside their parent's `fix_rows`, so they are searched too —
  // otherwise clicking a fix subrow's title would open an empty sheet. `fixOf`
  // carries the parent, which is the only place the fix's task context lives.
  const active = useMemo(() => {
    if (activeNum == null) return null
    const parent = prs.find((p) => p.number === activeNum)
    if (parent) return { pr: parent, fixOf: null as PR | null }
    for (const p of prs) {
      const fix = p.fix_rows?.find((f) => f.number === activeNum)
      if (fix) return { pr: fix, fixOf: p }
    }
    return null
  }, [prs, activeNum])

  const filtered = useMemo(() => {
    const needle = search.toLowerCase().trim()
    return prs.filter((p) => {
      if (state !== "all" && p.state !== state) return false
      if (field.length) {
        // `__domain:<slug>` matches any item in that domain; a plain slug
        // matches by subfield. A PR passes if it matches ANY selected entry.
        const ok = field.some((f) =>
          f.startsWith("__domain:")
            ? p.domain === f.slice("__domain:".length)
            : p.subfield === f,
        )
        if (!ok) return false
      }
      if (stage.length && !stage.includes(p.review_stage)) return false
      if (ball && p.ball_in_court !== ball) return false
      if (author.length && !author.includes(p.author.login)) return false
      if (dri.length && !p.reviewers.some((d) => dri.includes(d.login))) return false
      if (ci.length && !ci.includes(p.ci ?? "")) return false
      if (propStatus.length) {
        const lp = p.linked_proposal
        const ok = propStatus.some((s) => (s === "none" ? !lp : lp?.status === s))
        if (!ok) return false
      }
      if (fit.length) {
        const ok = fit.some((f) => (f === "coi" ? !!p.coi : p.author_fit === f))
        if (!ok) return false
      }
      if (tags.length && !tags.some((t) => p.labels.includes(t))) return false
      if (needle) {
        // Labels are searchable so hardware/workflow tags that have no column of
        // their own (e.g. `gpu`) are still reachable by typing their name.
        const hay =
          `${p.number} ${p.title} ${p.author.login} ${p.reviewers.map((d) => d.login).join(" ")} ${p.field ?? ""} ${searchableLabels(p.labels).join(" ")}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [prs, search, state, field, stage, ball, author, dri, ci, propStatus, fit, tags])

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
  // Tag options come straight from the data, so a label upstream adds later
  // shows up as a filter choice without a code change. Most-common first.
  const tagOptions = useMemo(() => {
    const c: Record<string, number> = {}
    for (const p of stateFiltered) {
      for (const t of tagLabels(p.labels)) c[t] = (c[t] ?? 0) + 1
    }
    return Object.entries(c)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value, count]) => ({
        value,
        label: value,
        render: <TagChip tag={value} />,
        count,
      }))
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
        cell: ({ row }) => {
          // On a fix subrow, say which task PR it belongs to. It goes here
          // rather than in the title so every column stays aligned with the
          // parent's.
          // A subrow knows its parent from the table; a fix listed in the Task
          // Fixes tab is top-level, so it carries the numbers on the row.
          const parentNums =
            row.depth > 0
              ? [row.getParentRow()?.original.number].filter(
                  (n): n is number => typeof n === "number",
                )
              : (row.original.fix_of ?? [])
          return (
            <span className="inline-flex flex-col items-start gap-1">
              {parentNums.length > 0 && (
                /* One parent fits; a fix spanning several tasks (or matching a
                   task's closed duplicates) would overflow the column, so the
                   rest collapse into +N with the full list in the tooltip. */
                <span
                  className="whitespace-nowrap font-mono text-[10px] leading-none text-muted-foreground"
                  title={`Fix for task PR ${parentNums.map((n) => `#${n}`).join(", ")}`}
                >
                  ↳ #{parentNums[0]}
                  {parentNums.length > 1 && ` +${parentNums.length - 1}`}
                </span>
              )}
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
          )
        },
      },
      {
        accessorKey: "title",
        size: 260,
        // The Tags facet hangs off this header rather than earning a column of
        // its own: only a handful of PRs carry a tag, so a Tags column would pay
        // width on every row to stay empty. The chips live in the cell below.
        header: () => {
          const cur = sorting[0]?.id === "title" ? sorting[0] : null
          return (
            <ColumnFilter
              title="TITLE"
              heading="Tags"
              options={tagOptions}
              selected={tags}
              onToggle={(v) => setTags(toggleVal(tags, v))}
              onClearAll={() => setTags([])}
              sortOptions={TITLE_SORT_OPTIONS}
              sortValue={cur ? `title:${cur.desc ? "desc" : "asc"}` : null}
              onSortChange={(v) =>
                setSorting(
                  v ? [{ id: "title", desc: v.endsWith(":desc") }] : [{ id: "number", desc: true }],
                )
              }
              {...openProps("title")}
            />
          )
        },
        cell: ({ row }) => {
          const fixes = row.original.fix_rows ?? []
          const expandedRow = row.getIsExpanded()
          return (
            <div className="flex flex-col gap-1">
              {/* Not a flex row: the chips ride in the text flow, so each behaves
                  like one more word at the end of the title — sitting after the
                  last word and wrapping with it. */}
              <div>
                <button
                  type="button"
                  onClick={() => setActiveNum(row.original.number)}
                  className="inline text-left font-medium hover:underline underline-offset-4"
                >
                  {row.original.title}
                </button>
                {tagLabels(row.original.labels).map((tag) => (
                  <Fragment key={tag}>
                    {" "}
                    <TagChip tag={tag} className="align-[1px]" />
                  </Fragment>
                ))}
              </div>
              {fixes.length > 0 && (
                /* The chips now EXPAND the fix as a subrow carrying the same
                   columns — its own CI, rubric and trials — rather than leaving
                   for GitHub. Nothing is lost: the subrow's own # cell links
                   upstream, exactly as a task row's does. One toggle serves the
                   whole group; a task rarely has more than two fixes. */
                <button
                  type="button"
                  onClick={() => row.toggleExpanded()}
                  aria-expanded={expandedRow}
                  className={cn(
                    "-ml-1 inline-flex w-fit items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-muted-foreground/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-muted-foreground/60",
                    // Reads as "on" while its fixes are showing.
                    expandedRow && "bg-muted-foreground/10 text-foreground",
                  )}
                  title={
                    expandedRow
                      ? "Hide the fix PRs"
                      : fixes.map((f) => `#${f.number} (${f.state}) — ${f.title}`).join("\n")
                  }
                >
                  <ChevronRight
                    className={cn(
                      "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
                      expandedRow && "rotate-90",
                    )}
                  />
                  <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {fixes.length} {fixes.length === 1 ? "fix" : "fixes"}
                  </span>
                  {/* Collapsed, the numbers are worth scanning; expanded, they
                      are right below in the rows themselves. */}
                  {!expandedRow &&
                    fixes.map((f) => (
                      <span
                        key={f.number}
                        className="font-mono text-[10px] tracking-wider text-muted-foreground/70"
                      >
                        #{f.number}
                      </span>
                    ))}
                </button>
              )}
            </div>
          )
        },
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
        // Comfortably fits the longest handle (AllenGrahamHart) + avatar.
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
        accessorKey: "dri",
        // Fits the longest handle (AllenGrahamHart) after the role label +
        // avatar; longer names truncate with an ellipsis (min-w-0 truncate).
        size: 280,
        header: () => (
          <ColumnFilter
            title="REVIEWER"
            selected={dri}
            onToggle={(v) => setDri(toggleVal(dri, v))}
            onClearAll={() => setDri([])}
            options={driOptions}
            {...openProps("dri")}
          />
        ),
        cell: ({ row }) => (
          // Reviewers link to their GitHub; filtering by reviewer is via the
          // column-header dropdown only (not by clicking a row entry).
          <ReviewersCell reviewers={row.original.reviewers} />
        ),
      },
      {
        accessorKey: "review_stage",
        size: 90,
        header: () => (
          <ColumnFilter
            title="STAGE"
            selected={stage}
            onToggle={(v) => setStage(toggleVal(stage, v))}
            onClearAll={() => setStage([])}
            options={STAGE_OPTIONS}
            {...openProps("stage")}
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
        // Header carries the filter + sort toggle; the cell is a small icon +
        // word + wait-time. ~95 keeps an even gap to the next column.
        size: 95,
        // Sort by how long the PR has waited in its current state (longest
        // first), so a follow-up queue is one click away. PRs not waiting on
        // anyone (null) sort last.
        sortDescFirst: true,
        sortingFn: (a, b) =>
          (a.original.ball_days ?? -1) - (b.original.ball_days ?? -1),
        header: ({ column }) => {
          const s = column.getIsSorted()
          return (
            <ColumnFilter
              title="ACTION"
              value={ball}
              onChange={setBall}
              options={BALL_OPTIONS}
              sortOptions={ACTION_SORT_OPTIONS}
              sortValue={s ? (s === "desc" ? "wait:desc" : "wait:asc") : null}
              onSortChange={(v) => {
                if (!v) setSorting([{ id: "number", desc: true }])
                else column.toggleSorting(v === "wait:desc")
              }}
            />
          )
        },
        cell: ({ row }) => (
          <BallChip
            ball={row.original.ball_in_court}
            days={row.original.ball_days}
            stage={row.original.review_stage}
            state={row.original.state}
          />
        ),
      },
      {
        accessorKey: "ci",
        // Just a single status icon under a short "CI" header — keep it tight.
        size: 50,
        header: () => (
          <ColumnFilter
            title="CI"
            selected={ci}
            onToggle={(v) => setCi(toggleVal(ci, v))}
            onClearAll={() => setCi([])}
            options={CI_OPTIONS}
            {...openProps("ci")}
          />
        ),
        cell: ({ row }) => <CIChip ci={row.original.ci} url={row.original.ci_url} />,
      },
      {
        accessorKey: "rubric",
        size: 90,
        header: "RUBRIC",
        cell: ({ row }) => <RubricChip rubric={row.original.rubric} />,
      },
      {
        accessorKey: "trials",
        size: 210,
        // Sort the column by average trial cost or runtime (the ⏱/$ toggles).
        // Rows with no reported value for the active metric sort last.
        sortingFn: (a, b) => {
          const pick = (r: typeof a) => {
            const t = r.original.trials
            if (trialMetric === "cost") return t?.avg_cost_usd ?? -1
            if (trialMetric === "time") return t?.avg_runtime_secs ?? -1
            // pass rate: passed / total; no trials sorts last
            return t && t.total ? t.passed / t.total : -1
          }
          return pick(a) - pick(b)
        },
        header: () => {
          const cur = sorting[0]?.id === "trials" ? sorting[0] : null
          const sortValue = trialMetric && cur ? `${trialMetric}:${cur.desc ? "desc" : "asc"}` : null
          return (
            <ColumnFilter
              title="FRONTIER TRIALS"
              value={null}
              onChange={() => {}}
              options={[]}
              sortOptions={TRIAL_SORT_OPTIONS}
              sortValue={sortValue}
              onSortChange={(v) => {
                if (!v) {
                  setTrialMetric(null)
                  setSorting([{ id: "number", desc: true }])
                  return
                }
                const [metric, dir] = v.split(":")
                setTrialMetric(metric as "cost" | "time" | "pass")
                setSorting([{ id: "trials", desc: dir === "desc" }])
              }}
            />
          )
        },
        cell: ({ row }) => {
          const t = row.original.trials
          return (
            <div className="flex flex-col gap-1">
              {t && t.has_rollup && t.total > 0 && (
                <CostTimeChip
                  ratePct={Math.round((t.passed / t.total) * 100)}
                  rateTone="pass"
                  rateTitle={`${t.passed}/${t.total} passed`}
                  costUsd={t.avg_cost_usd}
                  runtimeSecs={t.avg_runtime_secs}
                  costTrials={t.cost_trials}
                  runtimeTrials={t.runtime_trials}
                />
              )}
              <TrialsChip trials={t} />
            </div>
          )
        },
      },
      {
        accessorKey: "cheat",
        size: 180,
        sortingFn: (a, b) => {
          const pick = (r: typeof a) => {
            const c = r.original.cheat
            if (cheatMetric === "cost") return c?.avg_cost_usd ?? -1
            if (cheatMetric === "time") return c?.avg_runtime_secs ?? -1
            // success rate = succeeded / total; no cheat trials sorts last
            return c && c.total ? c.succeeded / c.total : -1
          }
          return pick(a) - pick(b)
        },
        header: () => {
          const cur = sorting[0]?.id === "cheat" ? sorting[0] : null
          const sortValue = cheatMetric && cur ? `${cheatMetric}:${cur.desc ? "desc" : "asc"}` : null
          return (
            <ColumnFilter
              title="CHEAT TRIALS"
              value={null}
              onChange={() => {}}
              options={[]}
              sortOptions={CHEAT_SORT_OPTIONS}
              sortValue={sortValue}
              onSortChange={(v) => {
                if (!v) {
                  setCheatMetric(null)
                  setSorting([{ id: "number", desc: true }])
                  return
                }
                const [metric, dir] = v.split(":")
                setCheatMetric(metric as "cost" | "time" | "success")
                setSorting([{ id: "cheat", desc: dir === "desc" }])
              }}
            />
          )
        },
        cell: ({ row }) => {
          const c = row.original.cheat
          return (
            <div className="flex flex-col gap-1">
              {c && c.has_rollup && c.total > 0 && (
                <CostTimeChip
                  ratePct={Math.round((c.succeeded / c.total) * 100)}
                  rateTone="cheat"
                  rateTitle={`${c.succeeded}/${c.total} cheats succeeded`}
                  costUsd={c.avg_cost_usd}
                  runtimeSecs={c.avg_runtime_secs}
                  costTrials={c.cost_trials}
                  runtimeTrials={c.runtime_trials}
                />
              )}
              <CheatChip cheat={c} />
            </div>
          )
        },
      },
      {
        accessorKey: "oracle_trials",
        // Narrow: the cell is a dot or two, with no model label.
        size: 72,
        // `/run agents=oracle` — the reference solution through the trial
        // harness. Its own column rather than a row inside FRONTIER TRIALS: it
        // is not an agent result, and mixing the two made the newest oracle run
        // read as the newest agent run.
        sortingFn: (a, b) => {
          const pick = (r: typeof a) => {
            const t = r.original.oracle_trials
            return t && t.total ? t.passed / t.total : -1
          }
          return pick(a) - pick(b)
        },
        header: () => {
          const cur = sorting[0]?.id === "oracle_trials" ? sorting[0] : null
          return (
            <ColumnFilter
              title="ORACLE"
              value={null}
              onChange={() => {}}
              options={[]}
              sortOptions={ORACLE_SORT_OPTIONS}
              sortValue={cur ? `pass:${cur.desc ? "desc" : "asc"}` : null}
              onSortChange={(v) =>
                setSorting(
                  v
                    ? [{ id: "oracle_trials", desc: v.endsWith(":desc") }]
                    : [{ id: "number", desc: true }],
                )
              }
              {...openProps("oracle_trials")}
            />
          )
        },
        cell: ({ row }) => {
          const t = row.original.oracle_trials
          return (
            <div className="flex flex-col gap-1">
              <TrialsChip trials={t} showModelLabel={false} />
            </div>
          )
        },
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
            options={FIT_FILTER_OPTIONS}
            {...openProps("fit")}
          />
        ),
        cell: ({ row }) => {
          const p = row.original
          if (!p.author_fit && !p.coi) {
            return <span className="text-xs text-muted-foreground">—</span>
          }
          return (
            <div className="flex flex-col items-start gap-1">
              <AuthorFitChip fit={p.author_fit} url={p.linked_proposal?.url ?? null} />
              {p.coi && <CoiBadge coi={p.coi} fromProposal />}
            </div>
          )
        },
      },
      {
        accessorKey: "linked_proposal",
        size: 130,
        header: () => (
          <ColumnFilter
            title="PROPOSAL"
            selected={propStatus}
            onToggle={(v) => setPropStatus(toggleVal(propStatus, v))}
            onClearAll={() => setPropStatus([])}
            options={PROPOSAL_STATUS_OPTIONS}
            {...openProps("propStatus")}
          />
        ),
        cell: ({ row }) => {
          const lp = row.original.linked_proposal
          if (!lp) return <span className="text-xs text-muted-foreground">—</span>
          const label = `#${lp.discussion_number}`
          return (
            <span className="inline-flex items-center gap-1.5">
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
              <HumanReviewChip status={lp.status} compact />
            </span>
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
        cell: ({ row }) => (
          <span
            className="text-muted-foreground"
            title={formatExactDateTime(row.original.updated_at)}
          >
            {formatRelativeTime(row.original.updated_at)}
          </span>
        ),
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
    [field, stage, ball, dri, author, ci, propStatus, fit, tags, fieldCounts, driOptions, authorOptions, tagOptions, trialMetric, cheatMetric, sorting, openCol],
  )

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting, expanded },
    onSortingChange: setSorting,
    onExpandedChange: setExpanded,
    // A task's `task fix` PRs are its subrows. They are DISPLAY-ONLY: `filtered`
    // is computed over the top-level `prs` (see the memo above), so a fix can
    // never pull its parent into a filter the parent doesn't match, and never
    // lands in the row count or any aggregate.
    getSubRows: (row) => row.fix_rows,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  })

  const anyChip = !!(
    field.length ||
    stage.length ||
    ball ||
    dri.length ||
    author.length ||
    ci.length ||
    propStatus.length ||
    fit.length ||
    tags.length
  )
  const { label: sortLabel, detail: sortDetail, isDefault: isDefaultSort } = prSortText(
    sorting,
    trialMetric,
    cheatMetric,
  )

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
      if (externalField) setField([externalField])
      setState(externalState ?? "all")
      onExternalFieldConsumed?.()
    }
  }, [externalField, externalState, onExternalFieldConsumed])

  return (
    <>
    <PRSheet
      pr={active?.pr ?? null}
      fixOf={active?.fixOf ?? null}
      open={active !== null}
      onOpenChange={(v) => !v && setActiveNum(null)}
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
              {stage.length > 0 && (
                <FilterChip
                  label="Stage"
                  value={stage.map((s) => STAGE_OPTIONS.find((o) => o.value === s)?.label ?? s).join(", ")}
                  onClear={() => setStage([])}
                />
              )}
              {ball && (
                <FilterChip label="Action" value={ball} onClear={() => setBall(null)} />
              )}
              {dri.length > 0 && (
                <FilterChip label="Reviewer" value={dri.join(", ")} onClear={() => setDri([])} />
              )}
              {author.length > 0 && (
                <FilterChip label="Author" value={author.join(", ")} onClear={() => setAuthor([])} />
              )}
              {ci.length > 0 && (
                <FilterChip
                  label="CI"
                  value={ci.map((c) => CI_OPTIONS.find((o) => o.value === c)?.label ?? c).join(", ")}
                  onClear={() => setCi([])}
                />
              )}
              {propStatus.length > 0 && (
                <FilterChip
                  label="Proposal"
                  value={propStatus
                    .map((s) => PROPOSAL_STATUS_OPTIONS.find((o) => o.value === s)?.label ?? s)
                    .join(", ")}
                  onClear={() => setPropStatus([])}
                />
              )}
              {fit.length > 0 && (
                <FilterChip
                  label="Author fit"
                  value={fit
                    .map((f) => FIT_FILTER_OPTIONS.find((o) => o.value === f)?.label ?? f)
                    .join(", ")}
                  onClear={() => setFit([])}
                />
              )}
              {tags.length > 0 && (
                <FilterChip label="Tags" value={tags.join(", ")} onClear={() => setTags([])} />
              )}
              <button
                type="button"
                className="px-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
                onClick={() => {
                  setField([])
                  setStage([])
                  setBall(null)
                  setAuthor([])
                  setDri([])
                  setCi([])
                  setPropStatus([])
                  setFit([])
                  setTags([])
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
              onClear={() => {
                setSorting([{ id: "number", desc: true }])
                setTrialMetric(null)
                setCheatMetric(null)
              }}
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
                  No task pull requests match these filters.
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                /* Fix subrows read as attached to the task above them: tinted,
                   with the title cell indented (see the title column). */
                <TableRow
                  key={row.id}
                  className={cn(
                    // Only the FIXES get the grey band — the task row keeps the
                    // ordinary row background so it still reads as the original.
                    // In dark, --muted (oklch .269) reads clearly against
                    // --background (.145); in light the two are 3% apart, so
                    // light gets a deeper neutral instead.
                    row.depth > 0 &&
                      "bg-neutral-200/70 hover:bg-neutral-200 dark:bg-muted dark:hover:bg-muted",
                    // The left rule runs down the whole group — including the
                    // expanded task row, where it's the marker that says "the
                    // rows below are mine" without touching the background.
                    (row.depth > 0 || (row.getIsExpanded() && row.subRows.length > 0)) &&
                      "border-l-2 border-l-muted-foreground/40",
                    // Drop the divider on every row of the group except its last.
                    (row.getIsExpanded() && row.subRows.length > 0) ||
                      (row.depth > 0 && row.index < (row.getParentRow()?.subRows.length ?? 0) - 1)
                      ? "border-b-0"
                      : undefined,
                  )}
                >
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

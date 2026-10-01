import { useMemo, useState, type ReactNode } from "react"
import { ChevronDown, UserRound } from "lucide-react"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { Issue, PR, Proposal, User } from "@/lib/data"
import type { ExtraState } from "@/lib/extraState"
import { useUrlState } from "@/lib/useUrlState"
import { cn } from "@/lib/utils"
import { IssuesTable } from "./IssuesTable"
import { PRsTable } from "./PRsTable"
import { ProposalsTable } from "./ProposalsTable"

// The selected reviewer is remembered per browser, so a reviewer picks
// themselves once. It also rides in `?me=` so a queue link can be shared — but
// a manual tab click rebuilds the query string, so the URL alone wouldn't stick.
const STORAGE_KEY = "tb-science-task-dashboard:reviewer"

function readStored(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? ""
  } catch {
    return ""
  }
}

function writeStored(login: string) {
  try {
    if (login) window.localStorage.setItem(STORAGE_KEY, login)
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage blocked (private window) — the URL param still carries it.
  }
}

const same = (a: string | null | undefined, b: string) =>
  !!a && a.toLowerCase() === b.toLowerCase()

type Sources = { prs: PR[]; fixes: PR[]; proposals: Proposal[]; issues: Issue[] }

/** Every row assigned to `login`, per tab — the same rows those tabs show. */
function assignedTo(login: string, d: Sources): Sources {
  const onPR = (p: PR) => p.reviewers.some((r) => same(r.login, login))
  return {
    proposals: d.proposals.filter((p) => same(p.reviewer?.login, login)),
    prs: d.prs.filter(onPR),
    fixes: d.fixes.filter(onPR),
    issues: d.issues.filter((i) => i.assignees.some((a) => same(a.login, login))),
  }
}

type KindKey = keyof Sources
type Tally = Record<KindKey, { todo: number; open: number }>

const KINDS: Array<{ key: KindKey; label: string }> = [
  { key: "proposals", label: "Proposals" },
  { key: "prs", label: "Task PRs" },
  { key: "fixes", label: "Task Fixes" },
  { key: "issues", label: "Task Issues" },
]

/** The assigned rows that are waiting on `login` right now. For PRs the
 *  `waiting on …` label is the team's source of truth for whose turn it is, so
 *  it wins over the reviewer's own (possibly stale) review state; a PR they've
 *  approved is never theirs, even while a co-reviewer is still pending. An
 *  issue with an open fix PR is in progress — the fix PR carries the work. */
function waitingFor(login: string, d: Sources): Sources {
  const prTodo = (p: PR) => {
    if (p.state !== "open" || p.ball_in_court === "author") return false
    const me = p.reviewers.find((r) => same(r.login, login))
    if (!me || me.status === "approved") return false
    return me.status === "pending" || p.ball_in_court === "reviewer"
  }
  return {
    proposals: d.proposals.filter((p) => p.status === "pending" && !p.closed),
    prs: d.prs.filter(prTodo),
    fixes: d.fixes.filter(prTodo),
    issues: d.issues.filter(
      (i) => i.state === "open" && !i.linked_prs.some((l) => l.state.toLowerCase() === "open"),
    ),
  }
}

/** Per tab: how many assigned rows are waiting on `login`, and how many are open. */
function tally(login: string, d: Sources): Tally {
  const w = waitingFor(login, d)
  return {
    proposals: { todo: w.proposals.length, open: d.proposals.filter((p) => p.status === "pending" && !p.closed).length },
    prs: { todo: w.prs.length, open: d.prs.filter((p) => p.state === "open").length },
    fixes: { todo: w.fixes.length, open: d.fixes.filter((p) => p.state === "open").length },
    issues: { todo: w.issues.length, open: d.issues.filter((i) => i.state === "open").length },
  }
}

const sumTally = (t: Tally, k: "todo" | "open") => KINDS.reduce((n, x) => n + t[x.key][k], 0)

/** The breakdown next to the reviewer's name: the total, then one count per
 *  type, each a link that scrolls to its section. Separated by spacing alone —
 *  filtering lives in each section's own table, so this only summarises. */
function TodoSummary({ tally }: { tally: Tally }) {
  const total = sumTally(tally, "todo")
  const parts = KINDS.filter((k) => k.key !== "issues" || tally.issues.open > 0)
  return (
    <span className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm text-muted-foreground">
      <span className="font-semibold text-foreground">{total} WAITING ON YOU</span>
      {parts.map((k) => (
        <a
          key={k.key}
          href={`#queue-${k.key}`}
          onClick={(e) => {
            e.preventDefault()
            document.getElementById(`queue-${k.key}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
          }}
          className="underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          <span className={cn("tabular-nums", tally[k.key].todo > 0 && "text-foreground")}>
            {tally[k.key].todo}
          </span>{" "}
          {k.label}
        </a>
      ))}
    </span>
  )
}

/** Everyone who holds at least one assignment anywhere. */
function collectReviewers(d: Sources): Array<User & { lower: string }> {
  const seen = new Map<string, User & { lower: string }>()
  const add = (u: User | null | undefined) => {
    if (!u?.login) return
    const lower = u.login.toLowerCase()
    const prev = seen.get(lower)
    if (!prev || (!prev.avatar_url && u.avatar_url)) {
      seen.set(lower, { login: u.login, avatar_url: u.avatar_url, lower })
    }
  }
  d.proposals.forEach((p) => add(p.reviewer))
  d.prs.forEach((p) => p.reviewers.forEach(add))
  d.fixes.forEach((p) => p.reviewers.forEach(add))
  d.issues.forEach((i) => i.assignees.forEach(add))
  return [...seen.values()]
}

function Avatar({ user }: { user: User }) {
  return user.avatar_url ? (
    <img src={user.avatar_url} alt="" className="h-5 w-5 shrink-0 rounded-full" loading="lazy" />
  ) : (
    <div className="h-5 w-5 shrink-0 rounded-full bg-muted" />
  )
}

function ReviewerPicker({
  reviewers,
  value,
  onChange,
  counts,
}: {
  reviewers: Array<User & { lower: string }>
  value: string
  onChange: (login: string) => void
  counts: Map<string, { waiting: number; open: number }>
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const current = reviewers.find((r) => same(r.login, value)) ?? null
  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim()
    return reviewers.filter((r) => !q || r.lower.includes(q))
  }, [reviewers, query])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex min-w-[220px] items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm hover:bg-accent"
        >
          {current ? (
            <>
              <Avatar user={current} />
              <span className="font-medium">{current.login}</span>
            </>
          ) : (
            <>
              <UserRound className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Select your name…</span>
            </>
          )}
          <ChevronDown className="ml-auto h-4 w-4 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0">
        <div className="border-b p-2">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search reviewers…"
            className="w-full rounded border bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex items-center justify-end gap-3 border-b px-3 py-1 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
          <span>to do</span>
          <span>open</span>
        </div>
        <div className="max-h-80 overflow-y-auto p-1">
          {filtered.length === 0 && (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">No match.</div>
          )}
          {filtered.map((r) => {
            const c = counts.get(r.lower) ?? { waiting: 0, open: 0 }
            return (
              <button
                key={r.lower}
                type="button"
                onClick={() => {
                  onChange(r.login)
                  setOpen(false)
                  setQuery("")
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
                  same(r.login, value) && "bg-accent",
                )}
              >
                <Avatar user={r} />
                <span className="min-w-0 flex-1 truncate">{r.login}</span>
                <span
                  className={cn(
                    "w-10 text-right text-xs tabular-nums",
                    c.waiting > 0 ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  {c.waiting}
                </span>
                <span className="w-7 text-right text-xs tabular-nums text-muted-foreground">{c.open}</span>
              </button>
            )
          })}
        </div>
        {value && (
          <div className="border-t p-1">
            <button
              type="button"
              onClick={() => {
                onChange("")
                setOpen(false)
              }}
              className="w-full rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent"
            >
              Clear selection
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function Section({ id, title, children }: { id: KindKey; title: string; children: ReactNode }) {
  return (
    <section id={`queue-${id}`} className="scroll-mt-4 space-y-3">
      {/* Same heading treatment as the page's "How to contribute" label. */}
      <h2 className="text-sm font-semibold uppercase tracking-wider text-foreground">{title}</h2>
      {children}
    </section>
  )
}

/** One reviewer's to-do list: the Proposals, Task PRs, Task Fixes and Issues
 *  tabs, each rendered with its own table and filtered to the rows assigned to
 *  the selected reviewer. */
export function ReviewerQueue(all: Sources) {
  const [urlMe, setUrlMe] = useUrlState<string>("me", "")
  const [me, setMeState] = useState<string>(() => urlMe || readStored())
  const setMe = (login: string) => {
    setMeState(login)
    setUrlMe(login)
    writeStored(login)
  }

  const { prs, fixes, proposals, issues } = all
  const sources = useMemo(() => ({ prs, fixes, proposals, issues }), [prs, fixes, proposals, issues])
  const reviewers = useMemo(() => collectReviewers(sources), [sources])
  const counts = useMemo(() => {
    const m = new Map<string, { waiting: number; open: number; tally: Tally }>()
    for (const r of reviewers) {
      const t = tally(r.login, assignedTo(r.login, sources))
      m.set(r.lower, { waiting: sumTally(t, "todo"), open: sumTally(t, "open"), tally: t })
    }
    return m
  }, [reviewers, sources])
  // Busiest first, so the picker doubles as a workload overview.
  const sortedReviewers = useMemo(
    () =>
      [...reviewers].sort(
        (a, b) =>
          (counts.get(b.lower)?.open ?? 0) - (counts.get(a.lower)?.open ?? 0) ||
          a.lower.localeCompare(b.lower),
      ),
    [reviewers, counts],
  )

  const mine = useMemo(() => (me ? assignedTo(me, sources) : null), [me, sources])
  // Each table gets a "Waiting on you" item in its own state toggle, selected
  // by default; the rest of the toggle (Open, Merged …) works as on its tab.
  const waiting = useMemo(() => {
    if (!me || !mine) return null
    const w = waitingFor(me, mine)
    const extra = <T,>(rows: T[]): ExtraState<T> => {
      const set = new Set(rows)
      return { label: "Waiting on you", match: (r) => set.has(r) }
    }
    return {
      proposals: extra(w.proposals),
      prs: extra(w.prs),
      fixes: extra(w.fixes),
      issues: extra(w.issues),
    }
  }, [me, mine])
  const c = me ? counts.get(me.toLowerCase()) : undefined

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-3">
        <ReviewerPicker reviewers={sortedReviewers} value={me} onChange={setMe} counts={counts} />
        {c && <TodoSummary tally={c.tally} />}
      </div>

      {!mine || !waiting ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          Pick your GitHub handle above to see every proposal, task PR and task fix assigned to you.
          Your choice is remembered in this browser.
        </div>
      ) : (
        <>
          <Section id="proposals" title="Task Proposals">
            <ProposalsTable proposals={mine.proposals} extraState={waiting.proposals} hideIdleFilters />
          </Section>
          <Section id="prs" title="Task Pull Requests">
            {/* Own URL namespaces so the queue's filters never leak into the
                main tabs (and the two PR tables here don't share theirs). */}
            <PRsTable prs={mine.prs} urlPrefix="q_" extraState={waiting.prs} hideIdleFilters />
          </Section>
          <Section id="fixes" title="Task Fixes">
            <PRsTable prs={mine.fixes} urlPrefix="qfix_" variant="fixes" extraState={waiting.fixes} hideIdleFilters />
          </Section>
          {mine.issues.length > 0 && (
            <Section id="issues" title="Task Issues">
              <IssuesTable issues={mine.issues} extraState={waiting.issues} hideIdleFilters />
            </Section>
          )}
        </>
      )}
    </div>
  )
}

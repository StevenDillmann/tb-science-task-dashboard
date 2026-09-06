export type User = {
  login: string
  avatar_url: string | null
}

export type ReviewState = "approved" | "changes_requested" | "pending"

/** Reviewer slot/role from the upstream hidden marker; null when the PR has no
 *  marker (most pre-parallel-model PRs). */
export type ReviewerRole = "domain" | "technical" | "final" | null

export type Reviewer = User & {
  status: ReviewState
  role: ReviewerRole
}

export type Domain =
  | "earth-sciences"
  | "life-sciences"
  | "physical-sciences"
  | "mathematical-sciences"
  | "engineering-sciences"

export type PRState = "open" | "closed" | "merged"

/** One `/run` result set: the per-model trial grid plus its roll-up. */
export type TrialRun = {
    passed: number
    total: number
    by_model: Array<{
      model: "claude" | "gpt" | "gemini" | "oracle" | "other"
      display: string
      results: Array<"pass" | "fail" | "none">
    }>
    url: string | null
    /** True only when the comment carried the pass-rate roll-up line. The
     *  rate·cost·time summary is shown only then, so the displayed % is always
     *  the authoritative roll-up and never a cell-derived guess. */
    has_rollup: boolean
    /** Blended average cost (USD) / runtime (seconds) across trials with a
     *  reported value, each over its own denominator. Null when not reported. */
    avg_cost_usd: number | null
    cost_trials: number
    avg_runtime_secs: number | null
    runtime_trials: number
    /** When this run was posted upstream (shown in the chip's tooltip). */
    at: string | null
  }

export type PR = {
  number: number
  title: string
  url: string
  is_draft: boolean
  state: PRState
  author: User
  domain: Domain | null
  subfield: string | null
  field: string | null
  /** Conflict of interest inherited from the linked proposal, or null. */
  coi: string | null
  /** Author–task fit inherited from the linked proposal, or null. */
  author_fit: "direct" | "adjacent" | "unrelated" | null
  review_stage: "1st" | "2nd" | "3rd" | "none"
  ball_in_court: "reviewer" | "author" | null
  /** When the PR last entered its current waiting state (ISO), and how many
   *  days ago — used to flag stale hand-offs in the Action column. */
  ball_since: string | null
  ball_days: number | null
  /** First active reviewer (back-compat); prefer `reviewers` for display. */
  dri: User | null
  /** Assigned reviewers (back-compat); prefer `reviewers` for display. */
  dris: User[]
  /** Every first-party reviewer with their real review status + slot role.
   *  Approved reviewers that GitHub dropped from the request list are included
   *  here (unlike `dris`), so this is the source of truth for the column. */
  reviewers: Reviewer[]
  age_days: number
  updated_days: number
  merged_days: number | null
  closed_days: number | null
  ci: string | null
  /** Where the CI dot links — the checks summary comment on the PR (falls back
   *  to the PR's Checks tab). Null when the PR carries no checks at all. */
  ci_url: string | null
  trials: TrialRun | null
  /** `/run agents=oracle` — the reference `solve.sh` driven through the same
   *  harness as an agent. Its own field so an oracle run is never read as an
   *  agent result, and never overwrites one. */
  oracle_trials: TrialRun | null
  rubric: {
    passed: number
    failed: number
    warning: number
    total: number
    url: string | null
  } | null
  cheat: {
    succeeded: number
    blocked: number
    total: number
    by_model: Array<{
      model: "claude" | "gpt" | "gemini" | "other"
      display: string
      results: Array<"succeeded" | "blocked" | "none">
    }>
    url: string | null
    /** True only when the "Successful cheats: X/Y" roll-up line was present. */
    has_rollup: boolean
    avg_cost_usd: number | null
    cost_trials: number
    avg_runtime_secs: number | null
    runtime_trials: number
  } | null
  linked_proposal: {
    proposal_number: number | null
    discussion_number: number
    title: string
    url: string
    status: "approved" | "rejected" | "pending"
  } | null
  /** Task Issue(s) a repair PR says it fixes ("Fixes #123"). The fix-side
   *  counterpart of `linked_proposal`; shown in the Task Fixes tab's ISSUE
   *  column. Empty on new-task PRs. */
  linked_issues?: Array<{
    number: number
    title: string
    url: string
    state: "open" | "closed"
    kind: "task fix" | "task" | "infra"
  }>
  body: string
  head_sha: string | null
  task_dir: string | null
  task_files: string[]
  created_at: string
  updated_at: string
  merged_at: string | null
  closed_at: string | null
  labels: string[]
  // `task fix` PRs touching this task's directory. Full rows, so an expanded
  // fix subrow fills the same columns as its parent. Display-only: they are
  // nested inside the parent and so never pull it into a filter it doesn't
  // match, and never reach the row count or any aggregate. The one filter they
  // follow is the state pill, so the rows can't contradict it: `merged` shows
  // merged and still-open fixes (a landed task can still have a fix in flight)
  // but not abandoned ones, `open`/`closed` show their own state, and `all`
  // shows the complete history.
  fix_rows: PR[]
  // On a `task fix` row: the task PRs it fixes. Empty when no task row matches
  // (the task is outside the fetched window, or upstream moved its directory) —
  // the fix is still listed in the Task Fixes tab.
  fix_of?: number[]
  // Set on a `task fix` spanning several task directories: how many it touches.
  // Such a row deliberately carries NO domain/subfield/field — one arbitrary tag
  // would claim the fix for whichever task sorts first in the diff — so the
  // field cell shows a `multi-task` chip instead of an empty one.
  multi_task?: number
}

export type ProposalState = "open" | "closed"

export type Proposal = {
  number: number
  proposal_number: number | null
  title: string
  raw_title: string
  url: string
  body: string
  comments_list: Array<{
    url: string | null
    created_at: string | null
    author: User
    body: string
  }>
  author: User
  domain: Domain | null
  subfield: string | null
  field: string | null
  /** Declared conflict-of-interest text, or null when none was disclosed. */
  coi: string | null
  /** Author–task fit from the discussion's `author-fit:` label (falls back to
   *  the rubric review's verdict). */
  author_fit: "direct" | "adjacent" | "unrelated" | null
  status: "approved" | "rejected" | "pending"
  state: ProposalState
  closed: boolean
  /** Domain reviewer assigned by the proposal-review workflow, or null when
   *  unassigned. Read from the workflow's sticky comment (upstream source). */
  reviewer: User | null
  llm_review: {
    recommendation: "accept" | "uncertain" | "reject" | "unknown"
    author_fit: "direct" | "adjacent" | "unrelated" | null
    url: string | null
  } | null
  age_days: number
  updated_days: number
  has_pr: boolean
  created_at: string
  updated_at: string
  closed_at: string | null
  labels: string[]
}

/** An assignee on an issue, tagged with the slot the routing workflow assigned
 *  them for (null for someone assigned by hand). */
export type IssueAssignee = User & { role: ReviewerRole }

/** How an issue was classified upstream-side (see build_issues):
 *  `task fix` — filed through the task-fix form; `task` — about a specific
 *  merged task but filed free-form; `infra` — everything else. */
export type IssueKind = "task fix" | "task" | "infra"

export type Issue = {
  number: number
  title: string
  url: string
  state: "open" | "closed"
  kind: IssueKind
  author: User
  /** Task directory (from the form, or a tasks/ path in the body), resolved
   *  against the live tree. Null for infra issues. */
  task_dir: string | null
  slug: string | null
  /** The original task PR the routing workflow traced the task to. */
  task_pr: number | null
  domain: Domain | null
  subfield: string | null
  /** The form's Category dropdown, verbatim. Null for free-form issues. */
  category: string | null
  assignees: IssueAssignee[]
  /** PRs that cross-reference this issue — normally the repair PR. */
  linked_prs: Array<{ number: number; state: string; url: string | null }>
  age_days: number
  updated_days: number
  created_at: string
  updated_at: string
  closed_at: string | null
  labels: string[]
  body: string
}

export type Coverage = Record<
  string,
  Record<string, { merged: number; in_review: number; proposed: number }>
>

export type Stats = {
  open_prs: number
  merged_prs: number
  closed_prs: number
  open_proposals: number
  closed_proposals: number
  approved_proposals: number
  declined_proposals: number
  pending_proposals: number
  needs_reviewer: number
  needs_author: number
  open_issues?: number
  open_task_issues?: number
}

/** Per-source completeness, each count measured against GitHub's own
 *  totalCount. `complete: false` means rows are missing — the header says so
 *  rather than letting a short list look whole. */
export type CoverageCheck = {
  complete: boolean
  sources: Record<string, { shown: number; upstream: number }>
}

export type Data = {
  generated_at: string
  upstream: string
  /** Per-section freshness: "stale" means the API was unreachable and that
   *  section fell back to its last cached fetch. */
  fetch_status?: Record<string, string>
  /** True when any section is stale — surfaced in the header. */
  partial?: boolean
  taxonomy: Record<string, Record<string, string[]>>
  field_labels: Record<string, string>
  field_to_domain: Record<string, Domain>
  coverage_check?: CoverageCheck
  prs: PR[]
  /** Every `task fix` PR as its own row. Also nested on the task rows they
   *  touch as `fix_rows`; unmatched fixes appear only here. */
  fixes: PR[]
  /** Every issue, classified and resolved to its task where it concerns one. */
  issues?: Issue[]
  proposals: Proposal[]
  coverage: Coverage
  stats: Stats
}

export async function loadData(): Promise<Data> {
  const url = `${import.meta.env.BASE_URL}data.json`
  const res = await fetch(url, { cache: "no-cache" })
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`)
  return res.json()
}

export const DOMAIN_LABELS: Record<Domain, string> = {
  "earth-sciences": "Earth Sciences",
  "life-sciences": "Life Sciences",
  "physical-sciences": "Physical Sciences",
  "mathematical-sciences": "Mathematical Sciences",
  "engineering-sciences": "Engineering Sciences",
}

export const DOMAIN_COLORS: Record<Domain, string> = {
  "earth-sciences": "bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-100",
  "life-sciences": "bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-100",
  "physical-sciences": "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100",
  "mathematical-sciences": "bg-yellow-100 text-yellow-900 dark:bg-yellow-900/40 dark:text-yellow-100",
  "engineering-sciences": "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
}

// Text-only domain colours, for labels/headers where a full badge would be too
// heavy (filter group headers, stats domain rows).
export const DOMAIN_TEXT_COLORS: Record<Domain, string> = {
  "earth-sciences": "text-blue-600 dark:text-blue-400",
  "life-sciences": "text-green-600 dark:text-green-400",
  "physical-sciences": "text-red-600 dark:text-red-400",
  "mathematical-sciences": "text-amber-600 dark:text-amber-400",
  "engineering-sciences": "text-zinc-500 dark:text-zinc-400",
}

// Field labels and field→domain mapping are now provided by the data payload
// (discovered from the upstream tasks/ folder tree). A small React context
// exposes them so cells/chips can render without prop-drilling.

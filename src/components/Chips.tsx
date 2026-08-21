import {
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  CircleHelp,
  Clock,
  Lock,
  Pen,
  RotateCw,
  Search,
  TriangleAlert,
  X as XIcon,
  XCircle,
} from "lucide-react"
import type { ComponentType, MouseEventHandler, ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { cn, formatExactDateTime } from "@/lib/utils"
import {
  DOMAIN_COLORS,
  DOMAIN_LABELS,
  type Domain,
  type Reviewer,
  type ReviewerRole,
  type ReviewState,
} from "@/lib/data"
import { useTaxonomy } from "@/lib/taxonomy"

/** "≈" glyph (author-fit "adjacent") — a partial/approximate match. Same props
 *  shape as a lucide icon so it drops into the icon slot. */
function ApproxGlyph({ className }: { className?: string; strokeWidth?: number }) {
  return (
    <span
      className={cn(
        "inline-flex h-3 w-3 items-center justify-center text-[13px] font-bold leading-none",
        className,
      )}
      aria-hidden
    >
      ≈
    </span>
  )
}

/** Wraps a chip's contents in a button when an onClick is provided.
 * Otherwise renders as a static div so it doesn't grab focus.
 */
function Clickable({
  onClick,
  active,
  className,
  title,
  children,
}: {
  onClick?: () => void
  active?: boolean
  className?: string
  title?: string
  children: ReactNode
}) {
  if (!onClick) return <span className={className}>{children}</span>
  const handler: MouseEventHandler = (e) => {
    e.stopPropagation()
    onClick()
  }
  return (
    <button
      type="button"
      onClick={handler}
      title={title ?? (active ? "Click to clear filter" : "Click to filter")}
      className={cn(
        "cursor-pointer transition-[outline-color,box-shadow]",
        active && "ring-2 ring-offset-1 ring-foreground/30",
        "hover:brightness-95 dark:hover:brightness-110",
        className,
      )}
    >
      {children}
    </button>
  )
}

export function DomainChip({ domain }: { domain: Domain | null }) {
  if (!domain) {
    return <Badge variant="outline" className="text-muted-foreground">—</Badge>
  }
  return (
    <Badge className={cn("border-transparent font-medium", DOMAIN_COLORS[domain])}>
      {DOMAIN_LABELS[domain]}
    </Badge>
  )
}

export function FieldChip({
  subfield,
  fallback,
  multiTask,
  onClick,
  active,
}: {
  subfield: string | null
  fallback: string | null
  /** Number of task directories a repo-wide `task fix` touches. Rendered in
   *  place of a field when there is none, so the blank reads as deliberate
   *  rather than as missing data. */
  multiTask?: number
  onClick?: () => void
  active?: boolean
}) {
  const { field_labels, field_to_domain } = useTaxonomy()
  let body: ReactNode
  if (subfield && field_labels[subfield]) {
    const domain = field_to_domain[subfield]
    body = (
      <Badge
        className={cn(
          "whitespace-nowrap border-transparent font-medium",
          DOMAIN_COLORS[domain],
        )}
      >
        {field_labels[subfield]}
      </Badge>
    )
  } else if (fallback) {
    body = (
      <Badge variant="outline" className="whitespace-nowrap text-muted-foreground">
        {fallback}
      </Badge>
    )
  } else if (multiTask && multiTask > 1) {
    // Not domain-coloured: the point is that this fix belongs to no one domain.
    return (
      <Badge
        variant="outline"
        className="whitespace-nowrap text-muted-foreground"
        title={`Touches ${multiTask} tasks across several fields`}
      >
        multi-task
      </Badge>
    )
  } else {
    return <Badge variant="outline" className="text-muted-foreground">—</Badge>
  }
  return (
    <Clickable onClick={subfield ? onClick : undefined} active={active}>
      {body}
    </Clickable>
  )
}

export function TypeText({
  type,
  onClick,
  active,
}: {
  type: string
  onClick?: () => void
  active?: boolean
}) {
  return (
    <Clickable onClick={onClick} active={active}>
      <span
        className={cn(
          "rounded px-1.5 py-0.5 text-xs",
          active ? "bg-accent text-accent-foreground" : "text-muted-foreground",
        )}
      >
        {type}
      </span>
    </Clickable>
  )
}

// Days a PR has sat in its current waiting state. Colour encodes urgency (the
// actionable signal); the reviewer/author label itself stays uncoloured so
// there's a single, unambiguous colour story. Ramp: green ≤2d (fresh),
// amber 3–7d (getting stale), red >7d (overdue — follow up).
function BallAge({ days }: { days: number }) {
  const tone =
    days <= 2
      ? "text-green-700 dark:text-green-400"
      : days <= 7
        ? "text-amber-600 dark:text-amber-400"
        : "text-red-700 dark:text-red-400"
  const text = days <= 0 ? "today" : `${days}d`
  const label =
    days <= 0 ? "less than a day" : `${days} day${days === 1 ? "" : "s"}`
  return (
    <span
      className={cn("text-[10px] font-medium tabular-nums", tone)}
      title={`Waiting in this state for ${label}`}
    >
      {text}
    </span>
  )
}

export function BallChip({
  ball,
  days,
  stage,
  state,
  onClick,
  active,
}: {
  ball: "reviewer" | "author" | null
  /** Days spent in the current waiting state; shown next to the label. */
  days?: number | null
  /** If the PR has all reviews complete (final approved) and is still open,
   *  surface that the only thing left is the merge. Stage and state are
   *  optional — pass them to enable the "ready" affordance. */
  stage?: "1st" | "2nd" | "3rd" | "none"
  state?: "open" | "merged" | "closed"
  onClick?: () => void
  active?: boolean
}) {
  // The reviewer/author label is neutral text + a muted role icon (Gavel =
  // reviewer delivers the verdict, SquarePen = author revises). Colour is
  // reserved for the wait-time age below (urgency) — one clear colour signal;
  // whose court it is reads from the icon + word.
  if (ball === "reviewer") {
    return (
      <Clickable onClick={onClick} active={active}>
        <span className="inline-flex flex-col items-start gap-0.5">
          <span className="inline-flex items-center gap-1 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
            <Search className="h-3 w-3" />
            reviewer
          </span>
          {typeof days === "number" && <BallAge days={days} />}
        </span>
      </Clickable>
    )
  }
  if (ball === "author") {
    return (
      <Clickable onClick={onClick} active={active}>
        <span className="inline-flex flex-col items-start gap-0.5">
          <span className="inline-flex items-center gap-1 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
            <Pen className="h-3 w-3" />
            author
          </span>
          {typeof days === "number" && <BallAge days={days} />}
        </span>
      </Clickable>
    )
  }
  if (ball === null && stage === "3rd" && state === "open") {
    return (
      <span
        className="text-xs font-medium text-green-700 dark:text-green-400"
        title="All reviews complete — awaiting maintainer merge"
      >
        completed
      </span>
    )
  }
  return <span className="text-xs text-muted-foreground">—</span>
}

// Subtle lifecycle marker under the # — just small muted lowercase text,
// faintly tinted by state. No dot, no filled badge, so it recedes.
type PillTone = "open" | "merged" | "closed" | "approved" | "declined"

// Same palette as the review-status glyphs: green = done, amber = active/open,
// grey = closed/declined.
const STATE_TEXT_TONE: Record<PillTone, string> = {
  open: "text-amber-600 dark:text-amber-400",
  merged: "text-green-700 dark:text-green-400",
  approved: "text-green-700 dark:text-green-400",
  closed: "text-red-700 dark:text-red-400",
  declined: "text-red-700 dark:text-red-400",
}

export function StatePill({ tone, label }: { tone: PillTone; label: string }) {
  return (
    <span className={cn("text-[10px] lowercase", STATE_TEXT_TONE[tone])}>{label}</span>
  )
}

// Glyph for a single slot's status. `locked` renders the final gate faintly
// when it isn't reachable yet.
function stageGlyph(status: ReviewState | "empty" | "locked"): ReactNode {
  if (status === "approved")
    return <CheckCircle2 className="h-3 w-3 text-green-700 dark:text-green-400" strokeWidth={2} />
  if (status === "changes_requested")
    return <RotateCw className="h-3 w-3 text-red-700 dark:text-red-400" strokeWidth={2.5} />
  if (status === "pending")
    return <Clock className="h-3 w-3 text-amber-600 dark:text-amber-400" strokeWidth={2.5} />
  if (status === "locked")
    return <CircleDashed className="h-3 w-3 text-muted-foreground/50" strokeWidth={2} />
  return <CircleDashed className="h-3 w-3 text-muted-foreground" strokeWidth={2} />
}

const STAGE_STATUS_WORD: Record<ReviewState, string> = {
  approved: "approved",
  changes_requested: "changes requested",
  pending: "pending",
}

export function StageChip({
  stage,
  action,
  reviewers,
  onClick,
  active,
}: {
  stage: "1st" | "2nd" | "3rd" | "none"
  /** Fallback "whose court" hint when per-reviewer data isn't available
   *  (merged/closed PRs, or PRs with no reviewer-slots marker). */
  action?: "reviewer" | "author" | null
  /** Per-reviewer slot statuses (domain/technical/final). When present, each dot
   *  reflects its own slot's reviewer — so e.g. domain pending + technical
   *  changes-requested renders amber + red, not both the same colour. */
  reviewers?: Reviewer[]
  onClick?: () => void
  active?: boolean
}) {
  const filled = stage === "1st" ? 1 : stage === "2nd" ? 2 : stage === "3rd" ? 3 : 0
  const baseLabels = [
    "No approvals yet",
    "1 approval",
    "2 approvals",
    "3 approvals",
  ]

  // Resolve each slot's status. Prefer the actual per-slot reviewer; fall back
  // to the approval count + global action when we have no role data.
  const byRole = new Map<string, Reviewer>()
  for (const r of reviewers ?? []) if (r.role) byRole.set(r.role, r)
  const havePerSlot = byRole.size > 0
  // Reviewers without a role marker, in order — used to fill the parallel dots
  // positionally so the number of lit dots matches the actual reviewer count
  // (a single reviewer lights ONE dot, not both).
  const unroled = (reviewers ?? []).filter((r) => !r.role)

  const parallelFilled = Math.min(filled, 2)
  const finalReached = filled >= 2
  const finalDone = filled >= 3

  // domain → dot 0, technical → dot 1.
  const slotStatus = (role: "domain" | "technical"): ReviewState | "empty" => {
    if (havePerSlot) return byRole.get(role)?.status ?? "empty"
    const i = role === "domain" ? 0 : 1
    // No role marker but we have reviewers: map each reviewer to a dot by
    // position; dots past the reviewer count stay empty.
    if (unroled.length) return unroled[i]?.status ?? "empty"
    // No reviewer data at all (merged/closed PRs): fall back to the approval
    // count + shared action colour.
    if (i < parallelFilled) return "approved"
    if (action === "author") return "changes_requested"
    if (action === "reviewer") return "pending"
    return "empty"
  }

  const finalStatus = (): ReviewState | "locked" => {
    if (havePerSlot) {
      const f = byRole.get("final")
      if (f) return f.status
      return finalDone ? "approved" : "locked"
    }
    if (finalDone) return "approved"
    if (finalReached && action === "author") return "changes_requested"
    if (finalReached && action === "reviewer") return "pending"
    return "locked"
  }

  const d = slotStatus("domain")
  const g = slotStatus("technical")
  const f = finalStatus()

  // Build a precise tooltip from the resolved slot statuses.
  let title = baseLabels[filled]
  if (havePerSlot) {
    const parts: string[] = []
    if (d !== "empty") parts.push(`domain ${STAGE_STATUS_WORD[d]}`)
    if (g !== "empty") parts.push(`technical ${STAGE_STATUS_WORD[g]}`)
    if (f !== "locked") parts.push(`final ${STAGE_STATUS_WORD[f as ReviewState]}`)
    if (parts.length) title = parts.join(" · ")
  } else if (filled < 3 && action === "author") {
    title = `${baseLabels[filled]} · changes requested`
  } else if (filled < 3 && action === "reviewer") {
    title = `${baseLabels[filled]} · pending review`
  }

  const finalActive = havePerSlot ? f !== "locked" : finalReached

  // Fixed-width cells so the Stage column stays aligned regardless of glyph.
  const cell = (node: ReactNode, key: string) => (
    <span key={key} className="inline-flex h-4 w-4 items-center justify-center">
      {node}
    </span>
  )

  return (
    <Clickable onClick={onClick} active={active} title={title}>
      <span className="inline-flex items-center gap-0.5">
        {cell(stageGlyph(d), "p0")}
        {cell(stageGlyph(g), "p1")}
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0",
            finalActive ? "text-muted-foreground" : "text-muted-foreground/40",
          )}
          strokeWidth={2}
        />
        {cell(stageGlyph(f), "f")}
      </span>
    </Clickable>
  )
}

export function CheatChip({
  cheat,
}: {
  cheat: {
    succeeded: number
    blocked: number
    total: number
    by_model: Array<{
      model: "claude" | "gpt" | "gemini" | "oracle" | "other"
      display: string
      results: Array<"succeeded" | "blocked" | "none">
    }>
    url: string | null
  } | null
}) {
  if (!cheat || cheat.total === 0) {
    return <span className="text-xs text-muted-foreground">—</span>
  }
  const { succeeded, blocked, total, by_model, url } = cheat
  const title = succeeded > 0
    ? `Cheat trials: ${succeeded} of ${total} succeeded — task is hackable`
    : `Cheat trials: all ${blocked} blocked`

  // One row per model, labelled + laid out exactly like the Trials column
  // (CLAUDE / GPT / GEMINI in a fixed-width tag) so the two columns line up
  // row-for-row and each cheat row is clearly attributed to its agent.
  const inner = by_model.length === 0 ? (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      {succeeded > 0 ? `${succeeded}/${total} hacked` : "safe"}
    </span>
  ) : (
    <span className="inline-flex flex-col gap-0.5">
      {by_model.map((m, i) => (
        <span key={i} className="inline-flex items-center gap-1.5" title={m.display}>
          <span className="w-12 text-[10px] font-medium tracking-wider text-muted-foreground">
            {MODEL_LABEL[m.model] ?? "OTHER"}
          </span>
          <span className="inline-flex items-center gap-px">
            {m.results.map((r, j) => {
              // Mirror upstream literally: ✅ in the cheat table → green check,
              // ❌ → red X. Reader applies cheat semantics (a ✓ here means the
              // agent successfully cheated = task is hackable).
              if (r === "succeeded") {
                return (
                  <Check
                    key={j}
                    className="h-3 w-3 text-green-700 dark:text-green-400"
                    strokeWidth={3}
                  />
                )
              }
              if (r === "blocked") {
                return (
                  <XIcon
                    key={j}
                    className="h-3 w-3 text-red-700 dark:text-red-400"
                    strokeWidth={3}
                  />
                )
              }
              return (
                <TriangleAlert
                  key={j}
                  className="h-3 w-3 text-amber-600 dark:text-amber-400"
                  strokeWidth={2}
                />
              )
            })}
          </span>
        </span>
      ))}
    </span>
  )

  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        title={title}
        onClick={(e) => e.stopPropagation()}
        className="hover:opacity-80"
      >
        {inner}
      </a>
    )
  }
  return <span title={title}>{inner}</span>
}

export function RubricChip({
  rubric,
}: {
  rubric: {
    passed: number
    failed: number
    warning: number
    total: number
    url: string | null
  } | null
}) {
  if (!rubric || rubric.total === 0) {
    return <span className="text-xs text-muted-foreground">—</span>
  }
  const { passed, failed, total, url } = rubric
  // Binary green/red: any failed criterion turns the chip red. The rubric
  // is pass/fail by design — there's no middle ground worth amber.
  const clean = failed === 0
  const text = clean
    ? "text-green-700 dark:text-green-400"
    : "text-red-700 dark:text-red-400"
  const inner = (
    <span className={cn("text-xs font-medium", text)}>
      {passed}/{total}
    </span>
  )
  const title = `Implementation rubric: ${passed} of ${total} criteria passed${failed ? ` (${failed} failed)` : ""}`
  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        title={title}
        onClick={(e) => e.stopPropagation()}
        className="hover:underline underline-offset-4"
      >
        {inner}
      </a>
    )
  }
  return <span title={title}>{inner}</span>
}

const MODEL_LABEL: Record<string, string> = {
  oracle: "ORACLE",
  claude: "CLAUDE",
  gpt: "GPT",
  gemini: "GEMINI",
  other: "OTHER",
}

// Reviewer slot labels, styled like the trial model labels (CLAUDE / GPT):
// a leading fixed-width uppercase muted tag so reviewer rows line up.
const ROLE_LABEL: Record<string, string> = {
  domain: "DOMAIN",
  technical: "TECHNICAL",
  final: "FINAL",
}

export function TrialsChip({
  trials,
  showModelLabel = true,
}: {
  /** Off in the ORACLE column, where the header already names the only row. */
  showModelLabel?: boolean
  trials: {
    passed: number
    total: number
    by_model: Array<{
      model: "claude" | "gpt" | "gemini" | "oracle" | "other"
      display: string
      results: Array<"pass" | "fail" | "none">
    }>
    url: string | null
    at?: string | null
  } | null
}) {
  if (!trials || trials.total === 0) {
    return <span className="text-xs text-muted-foreground">—</span>
  }
  const { passed, total, by_model, url, at } = trials
  // The run date matters on a merged task: a `task fix` may have changed the
  // task since, in which case these numbers describe the pre-fix version.
  const title =
    `Agent trials: ${passed} of ${total} passed` +
    (at ? ` · run ${formatExactDateTime(at)}` : "")

  // Fallback to summary chip if we couldn't parse per-model data.
  const inner = by_model.length === 0 ? (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      {passed}/{total}
    </span>
  ) : (
    <span className="inline-flex flex-col gap-0.5">
      {by_model.map((m, i) => (
        <span key={i} className="inline-flex items-center gap-1.5" title={m.display}>
          {showModelLabel && (
            <span className="w-12 text-[10px] font-medium tracking-wider text-muted-foreground">
              {MODEL_LABEL[m.model] ?? "OTHER"}
            </span>
          )}
          <span className="inline-flex items-center gap-px">
            {m.results.map((r, j) => {
              if (r === "pass") {
                return (
                  <Check
                    key={j}
                    className="h-3 w-3 text-green-700 dark:text-green-400"
                    strokeWidth={3}
                  />
                )
              }
              if (r === "fail") {
                return (
                  <XIcon
                    key={j}
                    className="h-3 w-3 text-red-700 dark:text-red-400"
                    strokeWidth={3}
                  />
                )
              }
              return (
                <TriangleAlert
                  key={j}
                  className="h-3 w-3 text-amber-600 dark:text-amber-400"
                  strokeWidth={2}
                />
              )
            })}
          </span>
        </span>
      ))}
    </span>
  )

  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        title={title}
        onClick={(e) => e.stopPropagation()}
        className="hover:opacity-80"
      >
        {inner}
      </a>
    )
  }
  return <span title={title}>{inner}</span>
}

export function CIChip({ ci, url }: { ci: string | null; url?: string | null }) {
  let icon: ReactNode
  let label: string
  if (ci === "success") {
    icon = (
      <CheckCircle2 className="h-4 w-4 text-green-700 dark:text-green-400" aria-label="CI passing" />
    )
    label = "CI passing"
  } else if (ci === "failure" || ci === "error") {
    icon = <XCircle className="h-4 w-4 text-red-700 dark:text-red-400" aria-label="CI failing" />
    label = "CI failing"
  } else if (ci === "pending") {
    icon = (
      <Clock
        className="h-4 w-4 text-amber-600 dark:text-amber-400"
        aria-label="CI pending — checks running or incomplete"
      />
    )
    label = "CI pending — checks running or incomplete"
  } else {
    // No gate checks on this PR — nothing to link to.
    return <span className="text-xs text-muted-foreground">—</span>
  }

  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        title={`${label} — open the checks summary`}
        onClick={(e) => e.stopPropagation()}
        className="inline-flex hover:opacity-80"
      >
        {icon}
      </a>
    )
  }
  return (
    <span title={label} className="inline-flex">
      {icon}
    </span>
  )
}

export function HumanReviewChip({
  status,
  compact,
}: {
  status: "approved" | "rejected" | "pending"
  /** When true, show only the icon (no label text). */
  compact?: boolean
}) {
  type Cfg = { Icon: typeof Check; label: string; text: string; title: string }
  const map: Record<string, Cfg> = {
    approved: {
      Icon: CheckCircle2,
      label: "approved",
      text: "text-green-700 dark:text-green-400",
      title: "Maintainer review: approved",
    },
    pending: {
      Icon: Clock,
      label: "pending",
      text: "text-amber-700 dark:text-amber-400",
      title: "Maintainer review: pending",
    },
    rejected: {
      Icon: XCircle,
      label: "declined",
      text: "text-red-700 dark:text-red-400",
      title: "Maintainer review: declined",
    },
  }
  const cfg = map[status] ?? map.pending
  return (
    <span
      title={cfg.title}
      className={cn("inline-flex items-center gap-1 text-xs font-medium", cfg.text)}
    >
      <cfg.Icon className="h-3 w-3" strokeWidth={2} />
      {!compact && cfg.label}
    </span>
  )
}

export function LLMReviewChip({
  recommendation,
  url,
  showIcon,
}: {
  recommendation: "accept" | "uncertain" | "reject" | "unknown" | null
  url: string | null
  /** Show the circle glyph before the word (side panel); tables use word only. */
  showIcon?: boolean
}) {
  if (!recommendation) {
    return <span className="text-xs text-muted-foreground">—</span>
  }
  type IconC = ComponentType<{ className?: string; strokeWidth?: number }>
  const map: Record<string, { label: string; text: string; title: string; Icon: IconC | null }> = {
    accept: {
      label: "accept",
      text: "text-green-700 dark:text-green-400",
      title: "LLM rubric review · accept",
      Icon: CheckCircle2 as IconC,
    },
    uncertain: {
      label: "uncertain",
      text: "text-amber-700 dark:text-amber-400",
      title: "LLM rubric review · uncertain",
      Icon: CircleHelp as IconC,
    },
    reject: {
      label: "reject",
      text: "text-red-700 dark:text-red-400",
      title: "LLM rubric review · reject",
      Icon: XCircle as IconC,
    },
    unknown: {
      label: "posted",
      text: "text-muted-foreground",
      title: "LLM rubric review present (no parseable recommendation)",
      Icon: null,
    },
  }
  const cfg = map[recommendation] ?? map.unknown
  // Panel shows just the icon (showIcon); tables show the word.
  const inner = (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium", cfg.text)}>
      {showIcon && cfg.Icon ? (
        <cfg.Icon className="h-3.5 w-3.5" strokeWidth={2} />
      ) : (
        cfg.label
      )}
    </span>
  )
  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        title={cfg.title}
        onClick={(e) => e.stopPropagation()}
        className="hover:underline underline-offset-4"
      >
        {inner}
      </a>
    )
  }
  return <span title={cfg.title}>{inner}</span>
}

export function AuthorFitChip({
  fit,
  url,
  showIcon,
}: {
  fit: "direct" | "adjacent" | "unrelated" | null
  url: string | null
  /** Show the ✓/≈/✗ glyph before the word (side panel); tables use word only. */
  showIcon?: boolean
}) {
  if (!fit) {
    return <span className="text-xs text-muted-foreground">—</span>
  }
  type IconC = ComponentType<{ className?: string; strokeWidth?: number }>
  const map: Record<string, { label: string; text: string; Icon: IconC }> = {
    direct: { label: "direct", text: "text-green-700 dark:text-green-400", Icon: Check as IconC },
    adjacent: { label: "adjacent", text: "text-amber-700 dark:text-amber-400", Icon: ApproxGlyph },
    unrelated: { label: "unrelated", text: "text-red-700 dark:text-red-400", Icon: XIcon as IconC },
  }
  const cfg = map[fit]
  // Advisory signal: author's stated relevance to the field, not verified expertise.
  const title = `Author–task fit · ${cfg.label} (advisory — stated relevance, not verified)`
  // Panel shows just the ✓/≈/✗ glyph (showIcon); tables show the word.
  const inner = (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium", cfg.text)}>
      {showIcon ? (
        <cfg.Icon className="h-3.5 w-3.5" strokeWidth={cfg.Icon === Check || cfg.Icon === XIcon ? 3 : 2} />
      ) : (
        cfg.label
      )}
    </span>
  )
  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        title={title}
        onClick={(e) => e.stopPropagation()}
        className="hover:underline underline-offset-4"
      >
        {inner}
      </a>
    )
  }
  return <span title={title}>{inner}</span>
}

/** Colours for the tags in `KNOWN_TAGS` (see lib/labels.ts, which decides which
 *  labels become tags at all). Upstream's own label hex, swapped for the matching
 *  GitHub dark-theme shade where the light one goes muddy against the dark
 *  surface. The neutral fallback only covers the two lists drifting apart. */
const TAG_STYLES: Record<string, { classes: string; title: string }> = {
  gpu: {
    classes:
      "border-[#8250df]/40 text-[#8250df] dark:border-[#a371f7]/50 dark:text-[#a371f7]",
    title: "Needs GPU hardware to run",
  },
  lite: {
    // Upstream's light teal (#c1e3e6) is 14.5:1 on the dark surface but 1.4:1 on
    // white — invisible as text. Dark mode keeps upstream's own shade; light mode
    // drops to the same hue (185°) at a value that clears AA.
    classes:
      "border-[#1d6c73]/40 text-[#1d6c73] dark:border-[#c1e3e6]/50 dark:text-[#c1e3e6]",
    title: "Good task, but may be too easy",
  },
}

/** A single upstream tag (see TAG_STYLES). Amber/purple carry meaning; unknown
 *  tags fall back to muted so they read as "a tag" without inventing a colour. */
export function TagChip({ tag, className }: { tag: string; className?: string }) {
  const style = TAG_STYLES[tag]
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-sm border px-1 py-px font-mono text-[10px] font-semibold uppercase leading-none tracking-wider",
        style?.classes ?? "border-muted-foreground/40 text-muted-foreground",
        className,
      )}
      title={style?.title ?? tag}
    >
      {tag}
    </span>
  )
}

/** "COI disclosed" — a proposal's (or its PR's) declared conflict of interest.
 *  Rendered as plain blue text so it reads as just another author-fit value
 *  alongside direct/adjacent/unrelated. `fromProposal` notes when a PR inherited
 *  it from the linked proposal. */
export function CoiBadge({ coi, fromProposal }: { coi: string; fromProposal?: boolean }) {
  return (
    <span
      className="text-xs font-medium text-blue-700 dark:text-blue-400"
      title={`Declared conflict of interest${fromProposal ? " (from linked proposal)" : ""}: ${coi}`}
    >
      COI disclosed
    </span>
  )
}

/** Blended trial roll-up shown under the trial dots: an optional pass/cheat
 *  rate, then average runtime · cost (fixed units — minutes & dollars — matching
 *  the /run comment). Each metric carries its own denominator in the tooltip. */
export function CostTimeChip({
  costUsd,
  runtimeSecs,
  costTrials,
  runtimeTrials,
  ratePct,
  rateTone,
  rateTitle,
}: {
  costUsd: number | null
  runtimeSecs: number | null
  costTrials?: number
  runtimeTrials?: number
  /** Pass rate (trials) or cheat-success rate (cheat), as a whole percent. */
  ratePct?: number | null
  rateTone?: "pass" | "cheat"
  rateTitle?: string
}) {
  const hasRate = ratePct != null
  if (!hasRate && costUsd == null && runtimeSecs == null) {
    return <span className="text-xs text-muted-foreground">—</span>
  }
  const time = runtimeSecs == null ? null : `${(runtimeSecs / 60).toFixed(1)}m`
  const cost = costUsd == null ? null : `$${costUsd.toFixed(2)}`
  const hasRun = time != null || cost != null
  const title = [
    rateTitle ?? null,
    runtimeSecs != null ? `avg runtime ${time} over ${runtimeTrials ?? 0} trial(s)` : null,
    costUsd != null ? `avg cost ${cost} over ${costTrials ?? 0} trial(s)` : null,
  ]
    .filter(Boolean)
    .join(" · ")
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 whitespace-nowrap text-[10px] font-medium text-blue-700 dark:text-blue-400"
    >
      {hasRate && (
        <span className="inline-flex items-center gap-0.5">
          {rateTone === "cheat" ? (
            <Lock className="h-3 w-3 shrink-0" strokeWidth={2} />
          ) : (
            <Check className="h-3 w-3 shrink-0" strokeWidth={3} />
          )}
          {ratePct}%
        </span>
      )}
      {hasRate && hasRun && <span className="opacity-40">·</span>}
      {hasRun && (
        <>
          <Clock className="h-3 w-3 shrink-0" />
          {time ?? "—"}
          <span className="opacity-40">·</span>
          {cost ?? "—"}
        </>
      )}
    </span>
  )
}

export function StatusChip({
  status,
  onClick,
  active,
}: {
  status: "approved" | "rejected" | "pending"
  onClick?: () => void
  active?: boolean
}) {
  let body: ReactNode
  if (status === "approved") {
    body = (
      <Badge className="border-transparent bg-green-500 text-green-50 hover:bg-green-500">
        approved
      </Badge>
    )
  } else if (status === "rejected") {
    body = (
      <Badge className="border-transparent bg-red-500 text-red-50 hover:bg-red-500">
        rejected
      </Badge>
    )
  } else {
    body = <Badge variant="outline">pending</Badge>
  }
  return (
    <Clickable onClick={onClick} active={active}>
      {body}
    </Clickable>
  )
}

/** Small trailing glyph for a reviewer's status: ✓ approved / ◌ pending /
 *  ✗ changes requested. Palette matches the Stage column. */
function ReviewStatusIcon({ status }: { status: ReviewState }) {
  if (status === "approved")
    return (
      <CheckCircle2
        className="h-3 w-3 shrink-0 text-green-700 dark:text-green-400"
        strokeWidth={2}
      />
    )
  if (status === "changes_requested")
    return (
      <RotateCw
        className="h-3 w-3 shrink-0 text-red-700 dark:text-red-400"
        strokeWidth={2.5}
      />
    )
  return (
    <Clock
      className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400"
      strokeWidth={2.5}
    />
  )
}

const REVIEW_STATUS_LABEL: Record<ReviewState, string> = {
  approved: "approved",
  changes_requested: "changes requested",
  pending: "pending review",
}

export function UserCell({
  user,
  onClick,
  active,
  status,
  role,
  reserveRole,
}: {
  user: { login: string; avatar_url: string | null } | null
  onClick?: () => void
  active?: boolean
  /** When set, render a trailing status glyph (reviewer rows). */
  status?: ReviewState
  /** When set, render a small slot-role tag (domain/technical/final). */
  role?: ReviewerRole
  /** Reserve the role-label slot even when this row has no role, so siblings
   *  with roles keep avatars aligned. */
  reserveRole?: boolean
}) {
  if (!user) return <span className="text-muted-foreground">—</span>
  const inner = (
    <span className="inline-flex max-w-full min-w-0 items-center gap-2 align-middle">
      {/* Reserve the fixed-width label slot whenever the cell has roles, so
          avatars share one left edge even on rows whose own role is blank. */}
      {(role || reserveRole) && (
        <span className="-mr-1 w-16 shrink-0 text-left text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
          {role ? (ROLE_LABEL[role] ?? role) : ""}
        </span>
      )}
      {user.avatar_url ? (
        <img
          src={user.avatar_url}
          alt=""
          className="h-5 w-5 shrink-0 rounded-full"
          loading="lazy"
        />
      ) : (
        <div className="h-5 w-5 shrink-0 rounded-full bg-muted" />
      )}
      <span className="min-w-0 truncate text-sm group-hover:underline">{user.login}</span>
      {status && <ReviewStatusIcon status={status} />}
    </span>
  )
  const titleSuffix = status ? ` · ${REVIEW_STATUS_LABEL[status]}` : ""
  if (onClick) {
    return (
      <button
        type="button"
        title={
          (active ? "Click to clear filter" : "Click to filter by this user") +
          titleSuffix
        }
        onClick={(e) => {
          e.stopPropagation()
          onClick()
        }}
        className={cn(
          "flex w-full max-w-full min-w-0 items-center rounded py-0.5 pr-2 hover:bg-accent",
          active && "bg-accent",
        )}
      >
        {inner}
      </button>
    )
  }
  return (
    <a
      href={`https://github.com/${user.login}`}
      target="_blank"
      rel="noreferrer"
      title={status ? REVIEW_STATUS_LABEL[status] : undefined}
      className="group flex w-full max-w-full min-w-0 items-center pr-2"
    >
      {inner}
    </a>
  )
}

/** Renders every reviewer on a PR (domain + technical, then final) as a stacked
 *  list, each with their real review status (✓/◌/✗) and slot role. In the
 *  parallel review model a PR has multiple reviewers at once, and approvers
 *  that GitHub dropped from the request list still belong here. */
export function ReviewersCell({
  reviewers,
  onClick,
  activeLogin,
}: {
  reviewers: Reviewer[]
  /** Optional click handler (e.g. to filter by that reviewer). */
  onClick?: (login: string) => void
  /** Login currently used as a filter, for highlight. */
  activeLogin?: string | null
}) {
  if (!reviewers || reviewers.length === 0)
    return <span className="text-muted-foreground">—</span>
  // If any reviewer in this cell has a role, reserve the label slot on every
  // row so avatars/names share one left edge.
  const anyRole = reviewers.some((u) => u.role)
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      {reviewers.map((u) => (
        <UserCell
          key={u.login}
          user={u}
          status={u.status}
          role={u.role}
          reserveRole={anyRole}
          onClick={onClick ? () => onClick(u.login) : undefined}
          active={activeLogin === u.login}
        />
      ))}
    </span>
  )
}

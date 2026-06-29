import {
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleDashed,
  Clock,
  RotateCw,
  TriangleAlert,
  X as XIcon,
  XCircle,
} from "lucide-react"
import type { ComponentType, MouseEventHandler, ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import {
  DOMAIN_COLORS,
  DOMAIN_LABELS,
  type Domain,
  type Reviewer,
  type ReviewerRole,
  type ReviewState,
} from "@/lib/data"
import { useTaxonomy } from "@/lib/taxonomy"

/** Lucide doesn't ship a plain `?` icon (only CircleHelp), so render one
 * via a typographic span styled like the other status icons. Accepts the
 * same props shape as a lucide icon (className, strokeWidth ignored). */
function QuestionGlyph({
  className,
}: {
  className?: string
  strokeWidth?: number
}) {
  return (
    <span
      className={cn(
        "inline-flex h-3 w-3 items-center justify-center text-[13px] font-bold leading-none",
        className,
      )}
      aria-hidden
    >
      ?
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
  onClick,
  active,
}: {
  subfield: string | null
  fallback: string | null
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

export function BallChip({
  ball,
  stage,
  state,
  onClick,
  active,
}: {
  ball: "reviewer" | "author" | null
  /** If the PR has all reviews complete (final approved) and is still open,
   *  surface that the only thing left is the merge. Stage and state are
   *  optional — pass them to enable the "ready" affordance. */
  stage?: "1st" | "2nd" | "3rd" | "none"
  state?: "open" | "merged" | "closed"
  onClick?: () => void
  active?: boolean
}) {
  // Matches the Stage column's palette: amber when waiting on reviewer (= the
  // amber pending circle), red when waiting on author (= the red iteration
  // arrow). Consistent "where is action needed" colour story.
  if (ball === "reviewer") {
    return (
      <Clickable onClick={onClick} active={active}>
        <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
          reviewer
        </span>
      </Clickable>
    )
  }
  if (ball === "author") {
    return (
      <Clickable onClick={onClick} active={active}>
        <span className="text-xs font-medium text-red-700 dark:text-red-400">
          author
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
    return <Check className="h-3.5 w-3.5 text-green-700 dark:text-green-400" strokeWidth={3} />
  if (status === "changes_requested")
    return <RotateCw className="h-3 w-3 text-red-700 dark:text-red-400" strokeWidth={2.5} />
  if (status === "pending")
    return <Circle className="h-3 w-3 text-amber-600 dark:text-amber-400" strokeWidth={2.5} />
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
  /** Per-reviewer slot statuses (domain/general/final). When present, each dot
   *  reflects its own slot's reviewer — so e.g. domain pending + general
   *  changes-requested renders amber + red, not both the same colour. */
  reviewers?: Reviewer[]
  onClick?: () => void
  active?: boolean
}) {
  const filled = stage === "1st" ? 1 : stage === "2nd" ? 2 : stage === "3rd" ? 3 : 0
  const baseLabels = [
    "No approvals yet",
    "1 of 2 parallel reviewers approved",
    "Both parallel reviewers approved",
    "Final reviewer approved",
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

  // domain → dot 0, general → dot 1.
  const slotStatus = (role: "domain" | "general"): ReviewState | "empty" => {
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
  const g = slotStatus("general")
  const f = finalStatus()

  // Build a precise tooltip from the resolved slot statuses.
  let title = baseLabels[filled]
  if (havePerSlot) {
    const parts: string[] = []
    if (d !== "empty") parts.push(`domain ${STAGE_STATUS_WORD[d]}`)
    if (g !== "empty") parts.push(`general ${STAGE_STATUS_WORD[g]}`)
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
      model: "claude" | "gpt" | "gemini" | "other"
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

  // No model labels (cheat uses the same agents as trials, redundant).
  const inner = by_model.length === 0 ? (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      {succeeded > 0 ? `${succeeded}/${total} hacked` : "safe"}
    </span>
  ) : (
    <span className="inline-flex flex-col gap-0.5">
      {by_model.map((m, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-px"
          title={m.display}
        >
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
  claude: "CLAUDE",
  gpt: "GPT",
  gemini: "GEMINI",
  other: "OTHER",
}

// Reviewer slot labels, styled like the trial model labels (CLAUDE / GPT):
// a leading fixed-width uppercase muted tag so reviewer rows line up.
const ROLE_LABEL: Record<string, string> = {
  domain: "DOMAIN",
  general: "GENERAL",
  final: "FINAL",
}

export function TrialsChip({
  trials,
}: {
  trials: {
    passed: number
    total: number
    by_model: Array<{
      model: "claude" | "gpt" | "gemini" | "other"
      display: string
      results: Array<"pass" | "fail" | "none">
    }>
    url: string | null
  } | null
}) {
  if (!trials || trials.total === 0) {
    return <span className="text-xs text-muted-foreground">—</span>
  }
  const { passed, total, by_model, url } = trials
  const title = `Agent trials: ${passed} of ${total} passed`

  // Fallback to summary chip if we couldn't parse per-model data.
  const inner = by_model.length === 0 ? (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      {passed}/{total}
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

export function CIChip({ ci }: { ci: string | null }) {
  if (ci === "success") {
    return (
      <CheckCircle2
        className="h-4 w-4 text-green-700 dark:text-green-400"
        aria-label="CI passing"
      />
    )
  }
  if (ci === "failure" || ci === "error") {
    return (
      <XCircle
        className="h-4 w-4 text-red-700 dark:text-red-400"
        aria-label="CI failing"
      />
    )
  }
  return <span className="text-xs text-muted-foreground">—</span>
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
      Icon: Check,
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
      Icon: XIcon,
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
      <cfg.Icon className="h-3 w-3" strokeWidth={cfg.Icon === Check || cfg.Icon === XIcon ? 3 : 2} />
      {!compact && cfg.label}
    </span>
  )
}

export function LLMReviewChip({
  recommendation,
  url,
  compact,
}: {
  recommendation: "accept" | "uncertain" | "reject" | "unknown" | null
  url: string | null
  /** When true, show only the icon (no label text). */
  compact?: boolean
}) {
  if (!recommendation) {
    return <span className="text-xs text-muted-foreground">—</span>
  }
  type IconC = ComponentType<{ className?: string; strokeWidth?: number }>
  type Cfg = { Icon: IconC | null; label: string; text: string; title: string }
  const map: Record<string, Cfg> = {
    accept: {
      Icon: Check as IconC,
      label: "accept",
      text: "text-green-700 dark:text-green-400",
      title: "LLM rubric review · accept",
    },
    uncertain: {
      Icon: QuestionGlyph,
      label: "uncertain",
      text: "text-amber-700 dark:text-amber-400",
      title: "LLM rubric review · uncertain",
    },
    reject: {
      Icon: XIcon as IconC,
      label: "reject",
      text: "text-red-700 dark:text-red-400",
      title: "LLM rubric review · reject",
    },
    unknown: {
      Icon: null,
      label: "posted",
      text: "text-muted-foreground",
      title: "LLM rubric review present (no parseable recommendation)",
    },
  }
  const cfg = map[recommendation] ?? map.unknown
  const inner = (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium", cfg.text)}>
      {cfg.Icon && (
        <cfg.Icon
          className="h-3 w-3"
          strokeWidth={cfg.Icon === Check || cfg.Icon === XIcon ? 3 : 2}
        />
      )}
      {!compact && cfg.label}
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
      <Check
        className="h-3.5 w-3.5 shrink-0 text-green-700 dark:text-green-400"
        strokeWidth={3}
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
    <Circle
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
  /** When set, render a small slot-role tag (domain/general/final). */
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
        <span className="w-14 shrink-0 text-left text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
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
      <span className="min-w-0 truncate text-sm">{user.login}</span>
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
      className="flex w-full max-w-full min-w-0 items-center pr-2 hover:underline"
    >
      {inner}
    </a>
  )
}

/** Renders every reviewer on a PR (domain + general, then final) as a stacked
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

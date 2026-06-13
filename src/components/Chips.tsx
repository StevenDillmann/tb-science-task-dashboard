import { CheckCircle2, CircleSlash, Clock, XCircle } from "lucide-react"
import type { MouseEventHandler, ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { DOMAIN_COLORS, DOMAIN_LABELS, type Domain } from "@/lib/data"
import { useTaxonomy } from "@/lib/taxonomy"

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
  onClick,
  active,
}: {
  ball: "reviewer" | "author" | null
  onClick?: () => void
  active?: boolean
}) {
  if (ball === "reviewer") {
    return (
      <Clickable onClick={onClick} active={active}>
        <Badge className="border-transparent bg-amber-500 text-amber-50 hover:bg-amber-500">
          reviewer
        </Badge>
      </Clickable>
    )
  }
  if (ball === "author") {
    return (
      <Clickable onClick={onClick} active={active}>
        <Badge className="border-transparent bg-violet-500 text-violet-50 hover:bg-violet-500">
          author
        </Badge>
      </Clickable>
    )
  }
  return <Badge variant="outline" className="text-muted-foreground">—</Badge>
}

export function StageChip({
  stage,
  onClick,
  active,
}: {
  stage: "1st" | "2nd" | "3rd" | "none"
  onClick?: () => void
  active?: boolean
}) {
  if (stage === "none") {
    return (
      <Clickable onClick={onClick} active={active}>
        <Badge variant="outline" className="text-muted-foreground">queued</Badge>
      </Clickable>
    )
  }
  const map = {
    "1st": "bg-zinc-200 text-zinc-900 dark:bg-zinc-700 dark:text-zinc-100",
    "2nd": "bg-blue-200 text-blue-900 dark:bg-blue-700 dark:text-blue-100",
    "3rd": "bg-green-200 text-green-900 dark:bg-green-700 dark:text-green-100",
  } as const
  return (
    <Clickable onClick={onClick} active={active}>
      <Badge className={cn("border-transparent", map[stage])}>{stage} pass ✓</Badge>
    </Clickable>
  )
}

export function CIChip({ ci }: { ci: string | null }) {
  if (!ci) {
    return <CircleSlash className="h-4 w-4 text-muted-foreground" aria-label="no CI" />
  }
  if (ci === "success") {
    return <CheckCircle2 className="h-4 w-4 text-green-600" aria-label="CI passing" />
  }
  if (ci === "failure" || ci === "error") {
    return <XCircle className="h-4 w-4 text-red-600" aria-label="CI failing" />
  }
  return <Clock className="h-4 w-4 text-amber-600" aria-label="CI pending" />
}

export function LLMReviewChip({
  recommendation,
  url,
}: {
  recommendation: "accept" | "uncertain" | "reject" | "unknown" | null
  url: string | null
}) {
  if (!recommendation) {
    return <span className="text-xs text-muted-foreground">—</span>
  }
  const map: Record<string, { dot: string; label: string; text: string; title: string }> = {
    accept: {
      dot: "bg-green-500",
      label: "accept",
      text: "text-green-700 dark:text-green-400",
      title: "LLM rubric review · accept",
    },
    uncertain: {
      dot: "bg-amber-500",
      label: "uncertain",
      text: "text-amber-700 dark:text-amber-400",
      title: "LLM rubric review · uncertain",
    },
    reject: {
      dot: "bg-red-500",
      label: "reject",
      text: "text-red-700 dark:text-red-400",
      title: "LLM rubric review · reject",
    },
    unknown: {
      dot: "bg-muted-foreground",
      label: "posted",
      text: "text-muted-foreground",
      title: "LLM rubric review present (no parseable recommendation)",
    },
  }
  const cfg = map[recommendation] ?? map.unknown
  const inner = (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium",
        cfg.text,
      )}
    >
      <span className={cn("size-2 rounded-full", cfg.dot)} />
      {cfg.label}
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

export function UserCell({
  user,
  onClick,
  active,
}: {
  user: { login: string; avatar_url: string | null } | null
  onClick?: () => void
  active?: boolean
}) {
  if (!user) return <span className="text-muted-foreground">—</span>
  const inner = (
    <span className="inline-flex items-center gap-2">
      {user.avatar_url ? (
        <img
          src={user.avatar_url}
          alt=""
          className="h-5 w-5 rounded-full"
          loading="lazy"
        />
      ) : (
        <div className="h-5 w-5 rounded-full bg-muted" />
      )}
      <span className="text-sm">{user.login}</span>
    </span>
  )
  if (onClick) {
    return (
      <button
        type="button"
        title={active ? "Click to clear filter" : "Click to filter by this user"}
        onClick={(e) => {
          e.stopPropagation()
          onClick()
        }}
        className={cn(
          "rounded px-1 py-0.5 hover:bg-accent",
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
      className="hover:underline"
    >
      {inner}
    </a>
  )
}

import { useState } from "react"
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import type { Proposal } from "@/lib/data"
import { FieldChip, HumanReviewChip, LLMReviewChip, UserCell } from "./Chips"

const BOT_LOGINS = new Set(["github-actions", "github-actions[bot]"])

function isLLMRubricComment(body: string): boolean {
  return body.includes("Task Proposal Rubric Review")
}

function relativeTime(iso: string | null): string {
  if (!iso) return ""
  const t = new Date(iso).getTime()
  const diff = Math.max(0, Date.now() - t)
  const days = Math.floor(diff / 86_400_000)
  if (days < 1) return "today"
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w ago`
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** Side panel that renders a proposal's full markdown body and discussion
 * thread. Bot comments are visually demoted and collapsible to keep noise low.
 */
export function ProposalSheet({
  proposal,
  open,
  onOpenChange,
}: {
  proposal: Proposal | null
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        {proposal && (
          <>
            <SheetHeader>
              <SheetTitle>
                {proposal.proposal_number !== null && (
                  <span className="mr-2 font-mono text-xs text-muted-foreground">
                    #{proposal.proposal_number}
                  </span>
                )}
                {proposal.title}
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
                <UserCell user={proposal.author} />
                <FieldChip subfield={proposal.subfield} fallback={proposal.field} />
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    LLM review
                  </span>
                  <LLMReviewChip
                    recommendation={proposal.llm_review?.recommendation ?? null}
                    url={proposal.llm_review?.url ?? null}
                    compact
                  />
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Human review
                  </span>
                  <HumanReviewChip status={proposal.status} compact />
                </span>
                <a
                  href={proposal.url}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
                >
                  Open on GitHub <ExternalLink className="h-3 w-3" />
                </a>
              </SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <article className="prose-tb max-w-none font-prose text-sm leading-relaxed">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {proposal.body || "_(no body)_"}
                </ReactMarkdown>
              </article>

              {proposal.comments_list.length > 0 && (
                <section className="mt-6 border-t pt-4">
                  <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Discussion ({proposal.comments_list.length})
                  </h3>
                  <ol className="space-y-3">
                    {proposal.comments_list.map((c, i) => (
                      <CommentCard key={c.url ?? i} comment={c} />
                    ))}
                  </ol>
                </section>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function CommentCard({
  comment,
}: {
  comment: Proposal["comments_list"][number]
}) {
  const isBot = BOT_LOGINS.has(comment.author.login)
  const isLLM = isBot && isLLMRubricComment(comment.body)
  // Collapse the long LLM rubric review by default; expand on click.
  const [expanded, setExpanded] = useState(!isLLM)

  return (
    <li
      className={cn(
        "rounded-md border p-3",
        isBot ? "border-border/60 bg-muted/40" : "bg-background",
      )}
    >
      <header className="mb-2 flex items-center gap-2 text-xs">
        <UserCell user={comment.author} />
        {isBot && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            bot
          </span>
        )}
        <span className="text-muted-foreground">{relativeTime(comment.created_at)}</span>
        {comment.url && (
          <a
            href={comment.url}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            title="Open this comment on GitHub"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </header>
      {isLLM && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mb-2 inline-flex items-center gap-1 rounded px-1 -mx-1 py-0.5 text-xs font-medium hover:bg-accent"
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          {expanded ? "Hide rubric review" : "Show rubric review"}
        </button>
      )}
      {expanded && (
        <article className="prose-tb max-w-none font-prose text-sm leading-relaxed">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {comment.body || "_(no content)_"}
          </ReactMarkdown>
        </article>
      )}
    </li>
  )
}

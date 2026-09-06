import { ExternalLink, GitPullRequest } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type { Issue } from "@/lib/data"
import { formatExactDateTime, formatRelativeTime } from "@/lib/utils"
import { FieldChip, IssueStatePill, StatePill, UserCell } from "./Chips"
import { KindChip } from "./IssuesTable"

const UPSTREAM = "harbor-framework/terminal-bench-science"

/** Side panel for one issue: what it's about, who it's routed to, any repair
 *  PR, and the body as filed. */
export function IssueSheet({
  issue,
  open,
  onOpenChange,
}: {
  issue: Issue | null
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        {issue && (
          <>
            <SheetHeader>
              <SheetTitle>
                <span className="mr-2 font-mono text-xs text-muted-foreground">#{issue.number}</span>
                {issue.title}
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
                <IssueStatePill state={issue.state} reason={issue.state_reason} />
                <KindChip kind={issue.kind} />
                <span className="inline-flex items-center gap-1.5">
                  <UserCell user={issue.author} />
                  <FieldChip subfield={issue.subfield} fallback={null} />
                </span>
                <span title={formatExactDateTime(issue.created_at)}>
                  opened {formatRelativeTime(issue.created_at)}
                </span>
                <a
                  href={issue.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 hover:text-foreground"
                >
                  Open on GitHub <ExternalLink className="h-3 w-3" />
                </a>
              </SheetDescription>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto px-6 py-4">
              {(issue.task_dir || issue.assignees.length || issue.linked_prs.length || issue.category) && (
                <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  {issue.task_dir && (
                    <>
                      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Task</dt>
                      <dd className="flex flex-wrap items-center gap-2">
                        <a
                          href={`https://github.com/${UPSTREAM}/tree/main/${issue.task_dir}`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-xs hover:underline"
                        >
                          {issue.task_dir}
                        </a>
                        {issue.task_pr && (
                          <a
                            href={`https://github.com/${UPSTREAM}/pull/${issue.task_pr}`}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-xs text-muted-foreground hover:underline"
                            title="The PR that landed this task"
                          >
                            task PR #{issue.task_pr}
                          </a>
                        )}
                      </dd>
                    </>
                  )}
                  {issue.category && (
                    <>
                      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Category</dt>
                      <dd>{issue.category}</dd>
                    </>
                  )}
                  <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Reviewer</dt>
                  <dd>
                    {issue.assignees.length ? (
                      <span className="flex flex-col gap-0.5">
                        {issue.assignees.map((a) => (
                          <UserCell key={a.login} user={a} role={a.role} reserveRole={issue.assignees.some((x) => x.role)} />
                        ))}
                      </span>
                    ) : issue.kind === "task fix" ? (
                      <span className="text-amber-600 dark:text-amber-400">
                        nobody yet — the routing workflow assigns the task's original reviewers when the issue is filed or edited
                      </span>
                    ) : (
                      <span className="text-muted-foreground">nobody</span>
                    )}
                  </dd>
                  {issue.linked_prs.length > 0 && (
                    <>
                      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Fix PR</dt>
                      <dd className="flex flex-col gap-0.5">
                        {issue.linked_prs.map((p) => (
                          <a
                            key={p.number}
                            href={p.url ?? `https://github.com/${UPSTREAM}/pull/${p.number}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 font-mono text-xs hover:underline"
                          >
                            <GitPullRequest className="h-3 w-3 text-muted-foreground" />#{p.number}
                            <StatePill
                              tone={p.state === "open" ? "open" : p.state === "merged" ? "merged" : "closed"}
                              label={p.state}
                            />
                          </a>
                        ))}
                      </dd>
                    </>
                  )}
                </dl>
              )}

              <article className="prose-tb max-w-none border-t pt-4 font-prose text-sm leading-relaxed">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{issue.body || "_(no body)_"}</ReactMarkdown>
              </article>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

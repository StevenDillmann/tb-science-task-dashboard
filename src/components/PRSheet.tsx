import { useEffect, useState } from "react"
import { ExternalLink, Loader2 } from "lucide-react"
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
import type { PR } from "@/lib/data"
import { tagLabels } from "@/lib/labels"
import {
  CIChip,
  CostTimeChip,
  FieldChip,
  RubricChip,
  StageChip,
  TagChip,
  TrialsChip,
  UserCell,
} from "./Chips"

const UPSTREAM = "harbor-framework/terminal-bench-science"

type Lang = "markdown" | "toml" | "dockerfile" | "bash" | "text"

function langForPath(path: string): Lang {
  if (path.endsWith(".md")) return "markdown"
  if (path.endsWith(".toml")) return "toml"
  if (path.endsWith("/Dockerfile") || path.endsWith(".dockerfile")) return "dockerfile"
  if (path.endsWith(".sh") || path.endsWith(".bash")) return "bash"
  return "text"
}

/** Top-level files that always get their own tab (when present). */
const ROOT_FILES = ["instruction.md", "task.toml"] as const
/** Directories whose files are listed as a group of sub-files. */
const FOLDER_GROUPS = ["environment", "tests", "solution"] as const

function rawUrl(sha: string, path: string): string {
  return `https://raw.githubusercontent.com/${UPSTREAM}/${sha}/${path}`
}

function blobUrl(sha: string, path: string): string {
  return `https://github.com/${UPSTREAM}/blob/${sha}/${path}`
}

export function PRSheet({
  pr,
  fixOf,
  open,
  onOpenChange,
}: {
  pr: PR | null
  /** Set when `pr` is a `task fix` opened from a subrow: the task PR it fixes.
   *  A fix carries no task identity of its own (no linked proposal, and a title
   *  that names the bug, not the task), so the parent is the only place that
   *  context lives. */
  fixOf?: PR | null
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        {pr && <Body pr={pr} fixOf={fixOf ?? null} />}
      </SheetContent>
    </Sheet>
  )
}

function Body({ pr, fixOf }: { pr: PR; fixOf: PR | null }) {
  // The active "page" in the panel — either "description" or a file path
  // relative to the task directory.
  const [active, setActive] = useState<string>("description")

  // Build the tab list from the PR's task_files.
  const taskFiles = pr.task_files ?? []
  const rootTabs = ROOT_FILES.filter((p) => taskFiles.includes(p))
  const groups = FOLDER_GROUPS
    .map((g) => ({
      name: g,
      files: taskFiles.filter((p) => p.startsWith(`${g}/`)).sort(),
    }))
    .filter((g) => g.files.length > 0)
  const otherFiles = taskFiles.filter(
    (p) =>
      !ROOT_FILES.includes(p as (typeof ROOT_FILES)[number]) &&
      !FOLDER_GROUPS.some((g) => p.startsWith(`${g}/`)),
  )
  return (
    <>
      <SheetHeader>
        <SheetTitle>
          <span className="mr-2 font-mono text-xs text-muted-foreground">
            #{pr.number}
          </span>
          {pr.title}
          {tagLabels(pr.labels).map((tag) => (
            <TagChip key={tag} tag={tag} className="ml-2 align-middle" />
          ))}
        </SheetTitle>
        {pr.linked_proposal && (
          <div className="pt-1 text-xs text-muted-foreground">
            Linked from{" "}
            <a
              href={pr.linked_proposal.url}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-foreground underline underline-offset-2 hover:text-[#038F99]"
            >
              Proposal #{pr.linked_proposal.discussion_number}
            </a>
            {pr.linked_proposal.title && (
              <span className="ml-2 italic">— {pr.linked_proposal.title}</span>
            )}
          </div>
        )}
        {fixOf && (
          <div className="pt-1 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Fixes task</span>{" "}
            <a
              href={fixOf.url}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[11px] font-semibold text-muted-foreground hover:underline underline-offset-2"
            >
              #{fixOf.number}
            </a>
            <span className="ml-2 italic">— {fixOf.title}</span>
          </div>
        )}
        {pr.fix_rows && pr.fix_rows.length > 0 && (
          <div className="pt-1 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              Task fixes:
            </span>{" "}
            {pr.fix_rows.map((f, i) => (
              <span key={f.number}>
                {i > 0 && ", "}
                <a
                  href={f.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:underline underline-offset-2"
                  title={`${f.title} (${f.state})`}
                >
                  fix #{f.number}
                </a>
                <span className="ml-1 text-[10px] uppercase text-foreground">
                  {f.state}
                </span>
              </span>
            ))}
          </div>
        )}
        <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-2">
          <span className="inline-flex items-center gap-1.5">
            <UserCell user={pr.author} />
            <FieldChip subfield={pr.subfield} fallback={pr.field} />
          </span>
          <LabeledChip label="Stage">
            <StageChip stage={pr.review_stage} action={pr.ball_in_court} reviewers={pr.reviewers} />
          </LabeledChip>
          <LabeledChip label="CI">
            <CIChip ci={pr.ci} url={pr.ci_url} />
          </LabeledChip>
          <LabeledChip label="Rubric">
            <RubricChip rubric={pr.rubric} />
          </LabeledChip>
          {pr.trials && pr.trials.has_rollup && pr.trials.total > 0 && (
            <LabeledChip label="Avg run">
              <CostTimeChip
                ratePct={Math.round((pr.trials.passed / pr.trials.total) * 100)}
                rateTone="pass"
                rateTitle={`${pr.trials.passed}/${pr.trials.total} passed`}
                costUsd={pr.trials.avg_cost_usd}
                runtimeSecs={pr.trials.avg_runtime_secs}
                costTrials={pr.trials.cost_trials}
                runtimeTrials={pr.trials.runtime_trials}
              />
            </LabeledChip>
          )}
          <TrialsChip trials={pr.trials} />
          {/* No label wrapper: the row inside already reads ORACLE. */}
          <TrialsChip trials={pr.oracle_trials} />
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
          >
            GitHub <ExternalLink className="h-3 w-3" />
          </a>
        </SheetDescription>
      </SheetHeader>

      <div className="border-b px-6 py-2">
        <nav className="flex flex-wrap items-center gap-x-1 gap-y-2">
          <TabButton
            active={active === "description"}
            onClick={() => setActive("description")}
          >
            Description
          </TabButton>
          {rootTabs.map((p) => (
            <TabButton
              key={p}
              active={active === p}
              onClick={() => setActive(p)}
            >
              {p}
            </TabButton>
          ))}
          {groups.map((g) => {
            const inside =
              active === g.name || active.startsWith(`${g.name}/`)
            return (
              <TabButton
                key={g.name}
                active={inside}
                onClick={() => setActive(g.name)}
              >
                {g.name}/
              </TabButton>
            )
          })}
          {otherFiles.length > 0 && (
            <TabButton
              active={active === "__other" || otherFiles.includes(active)}
              onClick={() => setActive("__other")}
            >
              other
            </TabButton>
          )}
        </nav>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {(() => {
          if (active === "description") {
            return (
              <article className="prose-tb max-w-none font-prose text-sm leading-relaxed">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {pr.body || "_(no description)_"}
                </ReactMarkdown>
              </article>
            )
          }
          if (!pr.task_dir || !pr.head_sha) {
            return (
              <p className="text-sm text-muted-foreground">
                File preview unavailable (no task directory detected on this PR).
              </p>
            )
          }
          // Folder index pages: list files in the selected folder.
          const folderMatch = groups.find((g) => g.name === active)
          if (folderMatch) {
            return (
              <FileList
                files={folderMatch.files}
                stripPrefix={`${folderMatch.name}/`}
                onPick={setActive}
              />
            )
          }
          if (active === "__other") {
            return (
              <FileList files={otherFiles} stripPrefix="" onPick={setActive} />
            )
          }
          // Resolve folder context for the back-link.
          const slash = active.indexOf("/")
          let parent: string | null = null
          let parentLabel: string | null = null
          if (slash >= 0 && groups.some((g) => g.name === active.slice(0, slash))) {
            parent = active.slice(0, slash)
            parentLabel = `${parent}/`
          } else if (otherFiles.includes(active)) {
            parent = "__other"
            parentLabel = "other"
          }
          return (
            <div className="space-y-3">
              {parent && (
                <button
                  type="button"
                  onClick={() => setActive(parent!)}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  ← Back to {parentLabel}
                </button>
              )}
              <FileView
                relativePath={active}
                taskDir={pr.task_dir}
                sha={pr.head_sha}
              />
            </div>
          )
        })()}
      </div>
    </>
  )
}

function LabeledChip({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </span>
  )
}

function TabButton({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md px-2 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  )
}

function FileList({
  files,
  stripPrefix,
  onPick,
}: {
  files: string[]
  stripPrefix: string
  onPick: (path: string) => void
}) {
  if (files.length === 0) {
    return <p className="text-sm text-muted-foreground">No files.</p>
  }
  return (
    <ul className="divide-y rounded-md border">
      {files.map((p) => (
        <li key={p}>
          <button
            type="button"
            onClick={() => onPick(p)}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent"
          >
            <span className="font-mono">
              {stripPrefix && p.startsWith(stripPrefix) ? p.slice(stripPrefix.length) : p}
            </span>
            <ExternalLink className="h-3 w-3 text-muted-foreground" />
          </button>
        </li>
      ))}
    </ul>
  )
}

function FileView({
  relativePath,
  taskDir,
  sha,
}: {
  relativePath: string
  taskDir: string
  sha: string
}) {
  const path = `${taskDir}/${relativePath}`
  const taskName = taskDir.split("/").pop() ?? taskDir
  const language = langForPath(path)
  const [state, setState] = useState<{
    status: "loading" | "ok" | "missing" | "error"
    text: string
  }>({ status: "loading", text: "" })

  useEffect(() => {
    let cancelled = false
    setState({ status: "loading", text: "" })
    fetch(rawUrl(sha, path), { cache: "force-cache" })
      .then(async (res) => {
        if (cancelled) return
        if (res.status === 404) {
          setState({ status: "missing", text: "" })
          return
        }
        if (!res.ok) {
          setState({ status: "error", text: `HTTP ${res.status}` })
          return
        }
        const text = await res.text()
        if (!cancelled) setState({ status: "ok", text })
      })
      .catch((e) => {
        if (!cancelled) setState({ status: "error", text: String(e) })
      })
    return () => {
      cancelled = true
    }
  }, [sha, path])

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2 text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1 break-all font-mono">
          <span className="text-foreground">{taskName}</span>/{relativePath}
        </span>
        <a
          href={blobUrl(sha, path)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap underline underline-offset-2 hover:text-foreground"
        >
          View on GitHub <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      {state.status === "loading" && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading…
        </div>
      )}
      {state.status === "missing" && (
        <p className="text-xs italic text-muted-foreground">
          File doesn't exist on this PR's head commit.
        </p>
      )}
      {state.status === "error" && (
        <p className="text-xs text-red-600 dark:text-red-400">
          Couldn't fetch ({state.text}). View on GitHub via the link above.
        </p>
      )}
      {state.status === "ok" && language === "markdown" && (
        <article className="prose-tb max-w-none font-prose text-sm leading-relaxed">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{state.text}</ReactMarkdown>
        </article>
      )}
      {state.status === "ok" && language !== "markdown" && (
        <pre className="overflow-x-auto rounded-md border bg-muted p-3 text-[12px] leading-relaxed">
          <code className="font-mono">{state.text}</code>
        </pre>
      )}
    </div>
  )
}

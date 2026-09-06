import {
  Award,
  ChevronRight,
  Crown,
  GitPullRequest,
  Send,
} from "lucide-react"

const FORM_URL = "https://airtable.com/appzZC5gEHrXSfNNw/pagjgS95lAQ5FVJxt/form"
const CONTRIBUTING_URL =
  "https://github.com/harbor-framework/terminal-bench-science/blob/main/CONTRIBUTING.md"
const CONTRIBUTORS_URL = "https://www.tbench.ai/contributors/terminal-bench-science"
const REVIEWER_POOL_URL =
  "https://github.com/harbor-framework/terminal-bench-science/blob/main/.github/reviewer-pool.yml"

/** Single-line contribution-process strip. Boxes = what you do, italicized
 * connectors between = what the maintainer team does. Just chevrons + text.
 */
export function Pipeline() {
  return (
    <section className="border-l-2 border-foreground/80 pl-4">
      <div className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        How to contribute
      </div>
      <p className="mb-3 font-prose text-sm leading-relaxed text-foreground">
        We're looking for tasks that are scientifically grounded, objectively
        verifiable, and beyond frontier AI agent capabilities. Contributors
        whose tasks land in the benchmark earn authorship credit, and top
        contributors are invited into the reviewer pool — a senior role with
        elevated authorship credit and area-chair candidacy for a scientific
        domain. For more details, see the{" "}
        <a
          href="https://www.tbench.ai/news/tb-science-announcement"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 transition-colors hover:text-[#038F99]"
        >
          contribution call
        </a>
        .
      </p>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
          <Step
            icon={Send}
            label="Propose"
            detail="Task proposal form"
            href={FORM_URL}
          />
          <Connector label="feedback & approval" />
          <Step
            icon={GitPullRequest}
            label="Pull request"
            detail="Contributing guide"
            href={CONTRIBUTING_URL}
          />
          <Connector label="review, iteration & merge" />
          <Step
            icon={Award}
            label="Contributor status"
            detail="Earn authorship credit"
            href={CONTRIBUTORS_URL}
          />
          <Connector label="invite-only" />
          <Step
            icon={Crown}
            label="Reviewer & maintainer status"
            detail="Extra authorship credit & area chair candidacy"
            href={REVIEWER_POOL_URL}
          />
        </div>
        <div className="ml-auto rounded-md border border-[#038F99]/30 bg-[#038F99]/10 px-4 py-2 text-right">
          <div className="text-[11px] font-bold uppercase tracking-wider text-[#038F99]">
            Pull request deadline
          </div>
          <div className="text-xs font-semibold text-[#038F99]">Oct 5, 2026</div>
        </div>
      </div>
    </section>
  )
}

function Step({
  icon: Icon,
  label,
  detail,
  href,
}: {
  icon: typeof Send
  label: string
  detail: string
  href?: string
}) {
  const inner = (
    <span className="inline-flex items-center gap-2">
      <Icon className="h-4 w-4" />
      <span className="leading-tight">
        <span className="block text-xs font-semibold uppercase tracking-wider">
          {label}
        </span>
        <span className="block text-[10px] text-muted-foreground transition-colors group-hover:text-[#038F99]">
          {detail}
        </span>
      </span>
    </span>
  )
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="group text-foreground transition-colors hover:text-[#038F99]"
      >
        {inner}
      </a>
    )
  }
  return <span className="text-foreground">{inner}</span>
}

function Connector({ label, href }: { label?: string; href?: string }) {
  const content = (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
      <ChevronRight className="h-3 w-3" />
      {label}
      {label && <ChevronRight className="h-3 w-3" />}
    </span>
  )
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="transition-colors hover:text-[#038F99]"
      >
        {content}
      </a>
    )
  }
  return content
}

import { useEffect, useMemo, useState } from "react"
import { AlertCircle, Calendar, Globe, Loader2, Mail } from "lucide-react"

import logoLight from "@/assets/tb-science-logo-light-bold.png"
import logoDark from "@/assets/tb-science-logo-dark-bold.png"

import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Pipeline } from "@/components/Pipeline"
import { PRsTable } from "@/components/PRsTable"
import { ProposalsTable } from "@/components/ProposalsTable"
import { StatsView } from "@/components/StatsView"
import { ThemeToggle } from "@/components/ThemeToggle"
import { DiscordIcon, GitHubIcon } from "@/components/icons"
import { loadData, type Data } from "@/lib/data"
import { TaxonomyProvider } from "@/lib/taxonomy"
import { useTheme } from "@/lib/theme"

const UPSTREAM = "harbor-framework/terminal-bench-science"
const DISCORD_URL = "https://discord.gg/2Pe5uWGcV3"
const WEBSITE_URL = "https://www.tbench.ai/news/tb-science-announcement"
const CALENDAR_URL =
  "https://calendar.google.com/calendar/embed?src=2ca3e7fdc9e51a42ce18142e897f7db23fbf8e65867da1a06dc3ea5e6ad4e893%40group.calendar.google.com&ctz=America%2FLos_Angeles&mode=WEEK"
const CONTACT_EMAIL = "stevendi@stanford.edu"

function formatGeneratedAt(iso: string): string {
  const d = new Date(iso)
  const min = Math.round((Date.now() - d.getTime()) / 60000)
  if (min < 1) return "just now"
  if (min < 60) return `${min} min ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 7) return `${day}d ago`
  const wk = Math.round(day / 7)
  return `${wk}w ago`
}

export default function App() {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<string>("proposals")
  // When the user clicks a count in Stats, the relevant tab opens and these
  // forced filters get applied by the table (then cleared).
  const [forcedField, setForcedField] = useState<string | null>(null)
  const [forcedProposalStatus, setForcedProposalStatus] = useState<
    "approved" | "pending" | "rejected" | null
  >(null)
  const [forcedPRState, setForcedPRState] = useState<
    "open" | "merged" | "closed" | null
  >(null)
  const { resolved } = useTheme()

  // Drafts are excluded everywhere — they aren't part of the contribution
  // funnel until they get marked ready for review.
  const visiblePRs = useMemo(
    () => (data ? data.prs.filter((p) => !p.is_draft) : []),
    [data],
  )

  useEffect(() => {
    loadData()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto flex flex-col gap-3 px-6 py-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-4">
            <img
              src={resolved === "dark" ? logoDark : logoLight}
              alt="Terminal-Bench Science"
              className="h-12 w-auto"
            />
            <div className="font-prose">
              <h1 className="text-xl font-semibold uppercase tracking-wider">
                Terminal-Bench Science · Task Dashboard
              </h1>
              <p className="text-sm text-muted-foreground">
                Task proposal and pull requests for Terminal-Bench Science.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {data && (
              <span className="text-xs text-muted-foreground">
                updated {formatGeneratedAt(data.generated_at)}
              </span>
            )}
            <ThemeToggle />
            <a
              href={WEBSITE_URL}
              target="_blank"
              rel="noreferrer"
              title="Terminal-Bench Science announcement"
              aria-label="Terminal-Bench Science announcement on tbench.ai"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <Globe className="h-5 w-5" />
            </a>
            <a
              href={`https://github.com/${UPSTREAM}`}
              target="_blank"
              rel="noreferrer"
              title={UPSTREAM}
              aria-label="GitHub repository"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <GitHubIcon className="h-5 w-5" />
            </a>
            <a
              href={DISCORD_URL}
              target="_blank"
              rel="noreferrer"
              title="Terminal-Bench Discord"
              aria-label="Discord"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <DiscordIcon className="h-5 w-5" />
            </a>
            <a
              href={CALENDAR_URL}
              target="_blank"
              rel="noreferrer"
              title="Terminal-Bench Science calendar — weekly meeting & office hours"
              aria-label="Terminal-Bench Science calendar"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <Calendar className="h-5 w-5" />
            </a>
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              title={`Email ${CONTACT_EMAIL}`}
              aria-label="Contact by email"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <Mail className="h-5 w-5" />
            </a>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-6 py-6">
        {error && (
          <div className="mb-4 flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4" />
            <div>
              <div className="font-medium">Couldn't load data.json</div>
              <div className="text-xs">{error}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Run <code>python3 scripts/fetch_data.py --out public/data.json</code> locally,
                or wait for the next scheduled rebuild.
              </div>
            </div>
          </div>
        )}

        {!data ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <TaxonomyProvider
            value={{
              taxonomy: data.taxonomy,
              field_labels: data.field_labels,
              field_to_domain: data.field_to_domain,
            }}
          >
            <div className="mb-6">
              <Pipeline />
            </div>
            <Tabs
              value={tab}
              onValueChange={(v) => {
                setTab(v)
                // Clear forced filters when the user moves tabs manually.
                setForcedField(null)
                setForcedProposalStatus(null)
                setForcedPRState(null)
              }}
            >
              <TabsList>
                <TabsTrigger value="proposals">
                  Task Proposals
                  <Badge variant="secondary" className="ml-2">
                    {data.proposals.length}
                  </Badge>
                </TabsTrigger>
                <TabsTrigger value="prs">
                  Task Pull Requests
                  <Badge variant="secondary" className="ml-2">
                    {visiblePRs.length}
                  </Badge>
                </TabsTrigger>
                <TabsTrigger value="stats">Statistics</TabsTrigger>
              </TabsList>

              <TabsContent value="proposals" className="mt-6">
                <ProposalsTable
                  proposals={data.proposals}
                  externalField={tab === "proposals" ? forcedField : null}
                  externalStatus={
                    tab === "proposals" ? forcedProposalStatus : null
                  }
                  onExternalFieldConsumed={() => {
                    setForcedField(null)
                    setForcedProposalStatus(null)
                  }}
                />
              </TabsContent>
              <TabsContent value="prs" className="mt-6">
                <PRsTable
                  prs={visiblePRs}
                  externalField={tab === "prs" ? forcedField : null}
                  externalState={tab === "prs" ? forcedPRState : null}
                  onExternalFieldConsumed={() => {
                    setForcedField(null)
                    setForcedPRState(null)
                  }}
                />
              </TabsContent>
              <TabsContent value="stats" className="mt-6">
                <StatsView
                  proposals={data.proposals}
                  prs={visiblePRs}
                  onPickField={(pick) => {
                    setForcedField(pick.field)
                    if (pick.kind === "proposals") {
                      setForcedProposalStatus(pick.status ?? null)
                      setForcedPRState(null)
                      setTab("proposals")
                    } else {
                      setForcedPRState(pick.state ?? null)
                      setForcedProposalStatus(null)
                      setTab("prs")
                    }
                  }}
                />
              </TabsContent>
            </Tabs>
          </TaxonomyProvider>
        )}
      </main>

      <footer className="container mx-auto flex flex-col gap-1 px-6 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <div>
          Rebuilds every 15 min from{" "}
          <a className="underline hover:text-foreground" href={`https://github.com/${UPSTREAM}`}>
            {UPSTREAM}
          </a>
          . Found an issue or have feedback? Email{" "}
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="underline hover:text-foreground"
          >
            {CONTACT_EMAIL}
          </a>
          .
        </div>
        <div>
          Created by{" "}
          <a
            href="https://github.com/StevenDillmann"
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-foreground"
          >
            Steven Dillmann
          </a>
          .
        </div>
      </footer>
    </div>
  )
}

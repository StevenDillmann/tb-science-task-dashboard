import { useEffect, useState } from "react"
import { AlertCircle, Globe, Loader2 } from "lucide-react"

import logoLight from "@/assets/tb-science-logo-light.png"
import logoDark from "@/assets/tb-science-logo-dark.png"

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

function formatGeneratedAt(iso: string): string {
  const d = new Date(iso)
  const min = Math.round((Date.now() - d.getTime()) / 60000)
  if (min < 1) return "just now"
  if (min < 60) return `${min} min ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  return d.toLocaleString()
}

export default function App() {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { resolved } = useTheme()

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
            <div>
              <h1 className="text-xl font-semibold tracking-tight">
                Terminal-Bench Science · Submission and Review Hub
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
            <Tabs defaultValue="proposals">
              <TabsList>
                <TabsTrigger value="proposals">
                  Task Proposals
                  <Badge variant="secondary" className="ml-2">
                    {data.stats.open_proposals}
                  </Badge>
                </TabsTrigger>
                <TabsTrigger value="prs">
                  Task Pull Requests
                  <Badge variant="secondary" className="ml-2">
                    {data.stats.open_prs}
                  </Badge>
                </TabsTrigger>
                <TabsTrigger value="stats">Stats</TabsTrigger>
              </TabsList>

              <TabsContent value="proposals" className="mt-6">
                <ProposalsTable proposals={data.proposals} />
              </TabsContent>
              <TabsContent value="prs" className="mt-6">
                <PRsTable prs={data.prs} />
              </TabsContent>
              <TabsContent value="stats" className="mt-6">
                <StatsView coverage={data.coverage} stats={data.stats} />
              </TabsContent>
            </Tabs>
          </TaxonomyProvider>
        )}
      </main>

      <footer className="container mx-auto px-6 py-6 text-xs text-muted-foreground">
        Rebuilds every 15 min from{" "}
        <a className="underline" href={`https://github.com/${UPSTREAM}`}>
          {UPSTREAM}
        </a>
        .
      </footer>
    </div>
  )
}

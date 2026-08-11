# tb-science-task-dashboard — Design

A public, auto-refreshing dashboard that gives the Terminal-Bench-Science reviewer team a single place to see open task PRs and task proposals, and gives the wider community visibility into what domains are covered or under-served.

## Goals

1. **Reviewers** know at a glance what PRs need their attention, who's the DRI, and whether the ball is in their court or the author's.
2. **Maintainers** can scan the proposal pipeline (approved / pending / rejected) without opening a dozen Discussions.
3. **Anyone** can see which scientific domains already have tasks and which still have gaps.

Non-goals: this is read-only. Reviews, approvals, and labeling still happen on GitHub.

## Architecture

```
tb-science-task-dashboard/  (this repo, public)
├─ .github/workflows/
│   └─ rebuild.yml          cron */15min + workflow_dispatch
├─ scripts/
│   ├─ fetch_data.py        gh GraphQL → data/data.json
│   └─ build_site.py        data/data.json + templates → site/
├─ site/                    static HTML/JS, published to gh-pages
│   ├─ index.html           tabs: PRs / Proposals / Stats
│   ├─ app.js               filtering/sorting (client-side)
│   ├─ style.css
│   └─ data.json
├─ DESIGN.md
└─ README.md
```

- GitHub Pages serves `site/` from the `gh-pages` branch.
- `GITHUB_TOKEN` (auto-provided to Actions) is enough for read-only API access to the public upstream repo.
- No backend, no database, no auth flow.

## Data model

Single source of truth: the [terminal-bench-science](https://github.com/harbor-framework/terminal-bench-science) GitHub repo, via the GraphQL API.

### PRs tab — one row per open task PR

| Column | Source |
| --- | --- |
| # | PR number → links to PR |
| Title | PR title |
| Author | login + avatar |
| Domain | top-level domain label (`earth-sciences`, `life-sciences`, `physical-sciences`, `mathematical-sciences`) |
| Type | `new task` / `task fix` / `documentation` |
| Review stage | derived from `1st review ✅` / `2nd review ✅` / `3rd review ✅` labels |
| Ball in court | `waiting on author` vs `waiting on reviewer` (color chip) |
| DRI | active requested reviewer |
| Age | days since opened, color by staleness |
| CI | last commit's check-run rollup (✅ / ❌ / ⏳) |
| Last activity | `updatedAt`, sortable |

**Filters:** domain · review stage · ball-in-court · DRI · author · "stalled > N days".
**Default sort:** ball-in-court = reviewer, then oldest first — the "what should I review next" view.

### Proposals tab — one row per Discussion in the "Task Proposals" category

| Column | Source |
| --- | --- |
| # | Discussion number → link |
| Proposal # | parsed from `[Task Proposal #N]` title prefix |
| Title | title with prefix stripped |
| Author | login |
| Domain | label on the discussion |
| Status | `approved` / `rejected` / `pending` — set by the `/approve` and `/reject` commands |
| Age | days since opened |
| Has PR? | green check if an open or merged PR references this proposal number |

**Filters:** domain · status · "pending only".

### Stats tab

- **Domain coverage matrix** — rows = subfields (from the `tasks/` folder tree + curated list); columns = `merged · in review · proposed · gap`.
- **Pipeline funnel** — proposals → approved → PR opened → merged, last 90 days.
- **Reviewer workload** — open DRIs per reviewer.
- **Author leaderboard** — tasks merged.

## Refresh model

- Cron: `*/15 * * * *` (every 15 minutes)
- `workflow_dispatch` manual button for "I need it now"
- Action: `uv run scripts/fetch_data.py` → `uv run scripts/build_site.py` → publish via `peaceiris/actions-gh-pages`
- Expected runtime: ~10–20s

Rationale for cron-and-publish rather than live-in-browser:
- Avoids exposing tokens or hitting per-IP rate limits in the browser.
- Single rebuild keeps every viewer consistent and fast.
- PRs and proposals move on hour-to-day timescales; 15-min staleness is invisible in practice.

## Tech choices

- **Backend script:** Python with `requests` for the GitHub GraphQL API. No DB.
- **Frontend:** vanilla HTML + one `app.js`, no framework, no build step. Filtering/sorting client-side over `data.json`. Loads instantly; easy to hack on.
- Optional later: a small dependency like Grid.js or Tabulator if hand-rolling table interactions gets annoying. Start without.

## Required upstream changes (handled separately by Steven)

The hub is useless without these on `terminal-bench-science`. Tracked here so the dependencies are explicit:

1. **Domain labels** — create four labels and enable them on both Discussions and PRs: `earth-sciences`, `life-sciences`, `physical-sciences`, `mathematical-sciences`.
2. **Auto-labeler workflow** — on Discussion open and PR open, parse the domain dropdown from the Airtable-form-generated body (or the `[TASK: <field>]` title prefix as a fallback) and apply the matching domain label.
3. **Approve/reject labels** — extend the existing `/approve` and `/reject` Discussion commands to also set an `approved` or `rejected` label, so the viewer has a stable filter signal.

Until these land, the hub renders with empty "Domain" chips and `pending` status everywhere.

## Open questions / future iterations

- Should the **Stats tab** surface a curated taxonomy of subfields (so gaps show up as empty rows) or only what already exists in the folder tree?
- Surface **LLM rubric scores** parsed from the auto-posted review comment on each PR?
- Surface whether `/validate` / `/run` / `/cheat` have been executed on a PR?
- Add a per-reviewer **"my queue"** view that filters to PRs where the signed-in user is DRI (would require a small client-side GitHub-login step, or just a `?dri=<login>` query param).
- RSS/Atom feed of new proposals and new PRs?

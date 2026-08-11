# tb-science-task-dashboard

A public, auto-refreshing dashboard for the Terminal-Bench-Science reviewer team — see open task PRs and proposals from [`harbor-framework/terminal-bench-science`](https://github.com/harbor-framework/terminal-bench-science) at a glance.

See [DESIGN.md](./DESIGN.md) for the full design.

## Local development

```bash
npm install        # one-time
npm run dev        # http://localhost:5173 with hot reload
```

Other scripts:

```bash
npm run build      # type-check + production build → dist/
npm run preview    # serve the built output locally
npm run lint       # type-check only
```

## Deployment

A GitHub Action rebuilds and publishes to GitHub Pages every 15 minutes (and on `workflow_dispatch` and `push` to `main`). No tokens or secrets required — the upstream repo is public.

To enable Pages: **Settings → Pages → Source: GitHub Actions**.

## Stack

- Vite + React + TypeScript
- Tailwind CSS + shadcn/ui (new-york style)
- TanStack Table for the data grids
- Lucide for icons

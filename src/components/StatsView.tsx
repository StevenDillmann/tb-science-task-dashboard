import { Fragment, useMemo, useState } from "react"
import { ArrowUpDown, ChevronDown, ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"
import { DOMAIN_LABELS, type Domain, type PR, type Proposal } from "@/lib/data"

const DOMAIN_TEXT: Record<Domain, string> = {
  "earth-sciences": "text-blue-600 dark:text-blue-400",
  "life-sciences": "text-green-600 dark:text-green-400",
  "physical-sciences": "text-red-600 dark:text-red-400",
  "mathematical-sciences": "text-amber-600 dark:text-amber-400",
  "engineering-sciences": "text-zinc-500 dark:text-zinc-400",
}

const DOMAIN_BG: Record<Domain, string> = {
  "earth-sciences": "bg-blue-50 dark:bg-blue-950/30",
  "life-sciences": "bg-green-50 dark:bg-green-950/30",
  "physical-sciences": "bg-red-50 dark:bg-red-950/30",
  "mathematical-sciences": "bg-amber-50 dark:bg-amber-950/30",
  "engineering-sciences": "bg-zinc-100 dark:bg-zinc-800/40",
}
import { useTaxonomy } from "@/lib/taxonomy"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

const KNOWN_ORDER: Domain[] = [
  "life-sciences",
  "physical-sciences",
  "earth-sciences",
  "mathematical-sciences",
  "engineering-sciences",
]

export type PickKind =
  | { kind: "proposals"; field: string; status?: "approved" | "pending" | "rejected" }
  | { kind: "prs"; field: string; state?: "open" | "merged" | "closed" }

type Row = {
  domain: Domain
  fieldSlug: string
  fieldLabel: string
  proposals: number
  approved: number
  prs: number
  merged: number
}

type SortKey = "field" | "proposals" | "approved" | "prs" | "merged"

export function StatsView({
  proposals,
  prs,
  onPickField,
}: {
  proposals: Proposal[]
  prs: PR[]
  onPickField: (pick: PickKind) => void
}) {
  const { taxonomy, field_labels } = useTaxonomy()
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: "merged",
    desc: true,
  })
  const [expanded, setExpanded] = useState<Set<Domain>>(new Set())
  const toggleDomain = (d: Domain) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(d)) next.delete(d)
      else next.add(d)
      return next
    })

  const rows = useMemo<Row[]>(() => {
    const allDomains = Object.keys(taxonomy) as Domain[]
    const sortedDomains = [
      ...KNOWN_ORDER.filter((d) => allDomains.includes(d)),
      ...allDomains.filter((d) => !KNOWN_ORDER.includes(d)),
    ]
    const out: Row[] = []
    for (const d of sortedDomains) {
      // Every discovered subfield in this domain.
      for (const slug of Object.keys(taxonomy[d])) {
        const inField = (p: { subfield: string | null }) => p.subfield === slug
        const propsInField = proposals.filter(inField)
        const prsInField = prs.filter(inField)
        out.push({
          domain: d,
          fieldSlug: slug,
          fieldLabel: field_labels[slug] ?? slug,
          proposals: propsInField.length,
          approved: propsInField.filter((p) => p.status === "approved").length,
          prs: prsInField.length,
          merged: prsInField.filter((p) => p.state === "merged").length,
        })
      }
    }
    // One catch-all bucket for anything without a recognized subfield,
    // regardless of which domain it claimed.
    const uncatProps = proposals.filter((p) => !p.subfield)
    const uncatPRs = prs.filter((p) => !p.subfield)
    if (uncatProps.length > 0 || uncatPRs.length > 0) {
      out.push({
        // Domain is unused for the uncategorized bucket (grouped under the
        // "__unknown" key and rendered with neutral styling); any valid Domain
        // satisfies the type.
        domain: "engineering-sciences",
        fieldSlug: "__unknown",
        fieldLabel: "(uncategorized)",
        proposals: uncatProps.length,
        approved: uncatProps.filter((p) => p.status === "approved").length,
        prs: uncatPRs.length,
        merged: uncatPRs.filter((p) => p.state === "merged").length,
      })
    }
    return out
  }, [taxonomy, field_labels, proposals, prs])

  // Group rows by domain (KNOWN_ORDER), then sort within each group using the
  // currently-selected column with the same cascade tiebreakers.
  const groupedRows = useMemo(() => {
    const cascade: SortKey[] = ["merged", "prs", "approved", "proposals", "field"]
    const order: SortKey[] = [sort.key, ...cascade.filter((k) => k !== sort.key)]
    const byDomain = new Map<Domain | "__unknown", Row[]>()
    for (const r of rows) {
      const key = r.fieldSlug === "__unknown" ? "__unknown" : r.domain
      const bucket = byDomain.get(key) ?? []
      bucket.push(r)
      byDomain.set(key, bucket)
    }
    for (const bucket of byDomain.values()) {
      bucket.sort((a, b) => {
        for (const k of order) {
          const cmp =
            k === "field"
              ? a.fieldLabel.localeCompare(b.fieldLabel)
              : a[k] - b[k]
          if (cmp !== 0) return sort.desc ? -cmp : cmp
        }
        return 0
      })
    }
    const ordered: { domain: Domain; subtotals: { proposals: number; approved: number; prs: number; merged: number }; children: Row[] }[] = []
    for (const d of KNOWN_ORDER) {
      const children = byDomain.get(d) ?? []
      if (children.length === 0) continue
      const subtotals = children.reduce(
        (acc, r) => ({
          proposals: acc.proposals + r.proposals,
          approved: acc.approved + r.approved,
          prs: acc.prs + r.prs,
          merged: acc.merged + r.merged,
        }),
        { proposals: 0, approved: 0, prs: 0, merged: 0 },
      )
      ordered.push({ domain: d, subtotals, children })
    }
    return { groups: ordered, uncategorized: byDomain.get("__unknown") ?? [] }
  }, [rows, sort])

  const toggle = (k: SortKey) =>
    setSort((s) =>
      s.key === k ? { key: k, desc: !s.desc } : { key: k, desc: k !== "field" },
    )

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, r) => ({
        proposals: acc.proposals + r.proposals,
        approved: acc.approved + r.approved,
        prs: acc.prs + r.prs,
        merged: acc.merged + r.merged,
      }),
      { proposals: 0, approved: 0, prs: 0, merged: 0 },
    )
  }, [rows])

  return (
    <div className="rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <SortHead label="Field" k="field" sort={sort} onToggle={toggle} />
            <SortHead label="Proposals" k="proposals" sort={sort} onToggle={toggle} numeric total={totals.proposals} />
            <SortHead label="Approved" k="approved" sort={sort} onToggle={toggle} numeric total={totals.approved} />
            <SortHead label="PRs" k="prs" sort={sort} onToggle={toggle} numeric total={totals.prs} />
            <SortHead label="Merged" k="merged" sort={sort} onToggle={toggle} numeric total={totals.merged} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {groupedRows.groups.map((g) => {
            const isOpen = expanded.has(g.domain)
            return (
            <Fragment key={g.domain}>
              <TableRow
                className={cn(
                  "cursor-pointer border-t-2 transition-colors hover:brightness-95 dark:hover:brightness-110",
                  DOMAIN_BG[g.domain],
                )}
                onClick={() => toggleDomain(g.domain)}
              >
                <TableCell className="py-2">
                  <span className="inline-flex items-center gap-2">
                    {isOpen ? (
                      <ChevronDown className="h-3 w-3 opacity-60" />
                    ) : (
                      <ChevronRight className="h-3 w-3 opacity-60" />
                    )}
                    <span
                      className={cn(
                        "text-xs font-bold uppercase tracking-wider",
                        DOMAIN_TEXT[g.domain],
                      )}
                    >
                      {DOMAIN_LABELS[g.domain] ?? g.domain}
                    </span>
                    {!isOpen && g.children.length > 0 && (
                      <span className="text-[11px] text-muted-foreground/70">
                        {g.children.map((c) => c.fieldLabel).join(", ")}
                      </span>
                    )}
                  </span>
                </TableCell>
                <SubtotalCell value={g.subtotals.proposals} />
                <SubtotalCell value={g.subtotals.approved} />
                <SubtotalCell value={g.subtotals.prs} />
                <SubtotalCell value={g.subtotals.merged} />
              </TableRow>
              {isOpen && g.children.map((r) => (
                <TableRow key={`${r.domain}/${r.fieldSlug}`}>
                  <TableCell className="pl-8 font-medium">{r.fieldLabel}</TableCell>
                  <NumCell
                    value={r.proposals}
                    onClick={() =>
                      onPickField({ kind: "proposals", field: r.fieldSlug })
                    }
                  />
                  <NumCell
                    value={r.approved}
                    onClick={() =>
                      onPickField({
                        kind: "proposals",
                        field: r.fieldSlug,
                        status: "approved",
                      })
                    }
                  />
                  <NumCell
                    value={r.prs}
                    onClick={() =>
                      onPickField({ kind: "prs", field: r.fieldSlug })
                    }
                  />
                  <NumCell
                    value={r.merged}
                    onClick={() =>
                      onPickField({
                        kind: "prs",
                        field: r.fieldSlug,
                        state: "merged",
                      })
                    }
                  />
                </TableRow>
              ))}
            </Fragment>
            )
          })}
          {groupedRows.uncategorized.length > 0 &&
            groupedRows.uncategorized.map((r) => (
              <TableRow key={`uncat/${r.fieldSlug}`} className="border-t">
                <TableCell className="pl-8 font-medium italic text-muted-foreground">
                  {r.fieldLabel}
                </TableCell>
                <NumCell
                  value={r.proposals}
                  onClick={() =>
                    onPickField({ kind: "proposals", field: r.fieldSlug })
                  }
                />
                <NumCell
                  value={r.approved}
                  onClick={() =>
                    onPickField({
                      kind: "proposals",
                      field: r.fieldSlug,
                      status: "approved",
                    })
                  }
                />
                <NumCell
                  value={r.prs}
                  onClick={() =>
                    onPickField({ kind: "prs", field: r.fieldSlug })
                  }
                />
                <NumCell
                  value={r.merged}
                  onClick={() =>
                    onPickField({
                      kind: "prs",
                      field: r.fieldSlug,
                      state: "merged",
                    })
                  }
                />
              </TableRow>
            ))}
          <TableRow className="border-t-2 bg-muted/40">
            <TableCell className="py-3 text-xs font-bold uppercase tracking-wider">
              Total
            </TableCell>
            <SubtotalCell value={totals.proposals} strong />
            <SubtotalCell value={totals.approved} strong />
            <SubtotalCell value={totals.prs} strong />
            <SubtotalCell value={totals.merged} strong />
          </TableRow>
        </TableBody>
      </Table>
    </div>
  )
}

function SortHead({
  label,
  k,
  sort,
  onToggle,
  numeric,
  total,
}: {
  label: string
  k: SortKey
  sort: { key: SortKey; desc: boolean }
  onToggle: (k: SortKey) => void
  numeric?: boolean
  total?: number
}) {
  return (
    <TableHead className={numeric ? "text-right" : ""}>
      <button
        type="button"
        onClick={() => onToggle(k)}
        className={cn(
          "inline-flex items-center gap-1.5",
          numeric && "ml-auto",
        )}
      >
        <span className="uppercase">{label}</span>
        {total !== undefined && (
          <span className="font-mono text-[10px] normal-case text-muted-foreground">
            {total}
          </span>
        )}
        <ArrowUpDown
          className={cn(
            "h-3 w-3",
            sort.key === k ? "" : "opacity-40",
          )}
        />
      </button>
    </TableHead>
  )
}

function NumCell({
  value,
  onClick,
}: {
  value: number
  onClick: () => void
}) {
  if (value === 0) {
    return (
      <TableCell className="text-right">
        <span className="font-mono text-xs text-muted-foreground/40">0</span>
      </TableCell>
    )
  }
  return (
    <TableCell className="text-right">
      <button
        type="button"
        onClick={onClick}
        className="rounded px-1.5 py-0.5 font-mono text-xs hover:bg-accent"
      >
        {value}
      </button>
    </TableCell>
  )
}

function SubtotalCell({ value, strong }: { value: number; strong?: boolean }) {
  return (
    <TableCell className="text-right">
      <span
        className={cn(
          "font-mono",
          strong ? "text-sm font-bold" : "text-xs font-semibold",
        )}
      >
        {value}
      </span>
    </TableCell>
  )
}

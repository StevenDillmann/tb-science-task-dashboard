export type User = {
  login: string
  avatar_url: string | null
}

export type Domain =
  | "earth-sciences"
  | "life-sciences"
  | "physical-sciences"
  | "mathematical-sciences"
  | "other"

export type PRState = "open" | "closed" | "merged"

export type PR = {
  number: number
  title: string
  url: string
  is_draft: boolean
  state: PRState
  author: User
  domain: Domain | null
  subfield: string | null
  field: string | null
  review_stage: "1st" | "2nd" | "3rd" | "none"
  ball_in_court: "reviewer" | "author" | null
  dri: User | null
  age_days: number
  updated_days: number
  merged_days: number | null
  closed_days: number | null
  ci: string | null
  trials: {
    passed: number
    total: number
    by_model: Array<{
      model: "claude" | "gpt" | "gemini" | "other"
      display: string
      results: Array<"pass" | "fail" | "none">
    }>
    url: string | null
  } | null
  rubric: {
    passed: number
    failed: number
    warning: number
    total: number
    url: string | null
  } | null
  cheat: {
    succeeded: number
    blocked: number
    total: number
    by_model: Array<{
      model: "claude" | "gpt" | "gemini" | "other"
      display: string
      results: Array<"succeeded" | "blocked" | "none">
    }>
    url: string | null
  } | null
  linked_proposal: {
    proposal_number: number | null
    discussion_number: number
    title: string
    url: string
  } | null
  created_at: string
  updated_at: string
  merged_at: string | null
  closed_at: string | null
  labels: string[]
}

export type ProposalState = "open" | "closed"

export type Proposal = {
  number: number
  proposal_number: number | null
  title: string
  raw_title: string
  url: string
  body: string
  comments_list: Array<{
    url: string | null
    created_at: string | null
    author: User
    body: string
  }>
  author: User
  domain: Domain | null
  subfield: string | null
  field: string | null
  status: "approved" | "rejected" | "pending"
  state: ProposalState
  closed: boolean
  llm_review: { recommendation: "accept" | "uncertain" | "reject" | "unknown"; url: string | null } | null
  age_days: number
  updated_days: number
  has_pr: boolean
  created_at: string
  updated_at: string
  closed_at: string | null
  labels: string[]
}

export type Coverage = Record<
  string,
  Record<string, { merged: number; in_review: number; proposed: number }>
>

export type Stats = {
  open_prs: number
  merged_prs: number
  closed_prs: number
  open_proposals: number
  closed_proposals: number
  approved_proposals: number
  declined_proposals: number
  pending_proposals: number
  needs_reviewer: number
  needs_author: number
}

export type Data = {
  generated_at: string
  upstream: string
  taxonomy: Record<string, Record<string, string[]>>
  field_labels: Record<string, string>
  field_to_domain: Record<string, Domain>
  prs: PR[]
  proposals: Proposal[]
  coverage: Coverage
  stats: Stats
}

export async function loadData(): Promise<Data> {
  const url = `${import.meta.env.BASE_URL}data.json`
  const res = await fetch(url, { cache: "no-cache" })
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`)
  return res.json()
}

export const DOMAIN_LABELS: Record<Domain, string> = {
  "earth-sciences": "Earth Sciences",
  "life-sciences": "Life Sciences",
  "physical-sciences": "Physical Sciences",
  "mathematical-sciences": "Mathematical Sciences",
  "other": "Other",
}

export const DOMAIN_COLORS: Record<Domain, string> = {
  "earth-sciences": "bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-100",
  "life-sciences": "bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-100",
  "physical-sciences": "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100",
  "mathematical-sciences": "bg-yellow-100 text-yellow-900 dark:bg-yellow-900/40 dark:text-yellow-100",
  "other": "bg-zinc-200 text-zinc-900 dark:bg-zinc-700 dark:text-zinc-100",
}

// Field labels and field→domain mapping are now provided by the data payload
// (discovered from the upstream tasks/ folder tree). A small React context
// exposes them so cells/chips can render without prop-drilling.

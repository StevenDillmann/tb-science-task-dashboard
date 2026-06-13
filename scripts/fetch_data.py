#!/usr/bin/env python3
"""Fetch PRs and Task Proposal Discussions from the upstream repo.

The field/domain taxonomy is discovered from the upstream `tasks/` directory tree
(not hardcoded). Per-PR field is derived from the file paths the PR touches
(authoritative); per-proposal field is parsed from the `## Scientific Domain`
section of the discussion body.

Uses the `gh` CLI for GraphQL/REST so we don't need a token explicitly:
- Locally: relies on `gh auth login`.
- In CI: `gh` picks up GITHUB_TOKEN automatically.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from typing import Any

UPSTREAM_OWNER = "harbor-framework"
UPSTREAM_NAME = "terminal-bench-science"
UPSTREAM = f"{UPSTREAM_OWNER}/{UPSTREAM_NAME}"

DOMAIN_LABEL_SET = {
    "earth-sciences",
    "life-sciences",
    "physical-sciences",
    "mathematical-sciences",
}

REVIEW_STAGE_LABELS = {
    "3rd review ✅": "3rd",
    "2nd review ✅": "2nd",
    "1st review ✅": "1st",
}

TASK_PROPOSAL_CATEGORY = "Task Proposals"

# Matches the structured "## Scientific Domain" section in proposal bodies.
SCIENTIFIC_DOMAIN_RE = re.compile(
    r"##\s*Scientific\s+Domain\s*\n+([^\n]+)", re.IGNORECASE
)

# Backfilled at the top of every proposal body: `**Proposed by @handle**`.
# Lets us attribute proposals to the original Airtable submitter rather than
# the GitHub account that posted the discussion on their behalf.
PROPOSED_BY_RE = re.compile(
    r"\*\*\s*Proposed by\s*@([A-Za-z0-9-]+)\s*\*\*", re.IGNORECASE
)


def gh(args: list[str]) -> str:
    res = subprocess.run(["gh", *args], capture_output=True, text=True, check=False)
    if res.returncode != 0:
        sys.stderr.write(res.stderr)
        raise SystemExit(res.returncode)
    return res.stdout


def graphql(query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
    args = ["api", "graphql", "-f", f"query={query}"]
    for k, v in (variables or {}).items():
        if isinstance(v, str):
            args += ["-f", f"{k}={v}"]
        else:
            args += ["-F", f"{k}={v}"]
    return json.loads(gh(args))


def slugify(text: str) -> str:
    """Turn 'Chemistry & Materials' into 'chemistry-and-materials'."""
    t = text.strip().lower()
    t = t.replace("&", " and ")
    t = re.sub(r"[^a-z0-9]+", "-", t)
    return t.strip("-")


def humanize(slug: str) -> str:
    """Inverse of slugify for display. 'chemistry-and-materials' → 'Chemistry & Materials'."""
    parts = slug.split("-")
    out: list[str] = []
    for p in parts:
        if p == "and":
            out.append("&")
        else:
            out.append(p[:1].upper() + p[1:])
    return " ".join(out)


def age_days(iso: str, now: datetime) -> int:
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return (now - dt).days


def parse_field_from_title(title: str) -> str | None:
    m = re.match(r"\s*\[\s*TASK\s*:\s*([^\]]+?)\s*\]", title, re.IGNORECASE)
    return m.group(1).strip() if m else None


def parse_proposal_number(title: str) -> tuple[int | None, str]:
    m = re.match(r"\s*\[\s*Task Proposal\s*#(\d+)\s*\]\s*(.*)", title, re.IGNORECASE)
    if m:
        return int(m.group(1)), m.group(2).strip()
    return None, title


def derive_review_stage(labels: list[str]) -> str:
    for lab, stage in REVIEW_STAGE_LABELS.items():
        if lab in labels:
            return stage
    return "none"


def derive_ball_in_court(labels: list[str]) -> str | None:
    if "waiting on author" in labels:
        return "author"
    if "waiting on reviewer" in labels:
        return "reviewer"
    return None


def derive_type(labels: list[str]) -> str:
    for lab in ("task fix", "documentation", "new task"):
        if lab in labels:
            return lab
    return "other"


def derive_status(labels: list[str]) -> str:
    if "approved" in labels:
        return "approved"
    if "rejected" in labels:
        return "rejected"
    return "pending"


# --- Taxonomy discovery -----------------------------------------------------

def fetch_tree() -> list[dict[str, Any]]:
    """Full recursive tree of the upstream default branch."""
    raw = gh(["api", f"repos/{UPSTREAM}/git/trees/HEAD?recursive=1"])
    return json.loads(raw).get("tree", [])


def discover_taxonomy(tree: list[dict[str, Any]]) -> tuple[
    dict[str, dict[str, list[str]]],
    dict[str, str],
    dict[str, str],
]:
    """Return (taxonomy, field_labels, field_to_domain) from `tasks/<domain>/<sub>/...`."""
    taxonomy: dict[str, dict[str, list[str]]] = {}
    for entry in tree:
        if entry.get("type") != "tree":
            continue
        path = entry.get("path", "")
        parts = path.split("/")
        if len(parts) < 2 or parts[0] != "tasks":
            continue
        if len(parts) == 2:
            taxonomy.setdefault(parts[1], {})
        elif len(parts) == 3:
            taxonomy.setdefault(parts[1], {}).setdefault(parts[2], [])

    # Drop any top-level entries that aren't domains we recognise from labels OR
    # that have no subfields (e.g. an "other" bucket might exist but we surface it).
    field_labels: dict[str, str] = {}
    field_to_domain: dict[str, str] = {}
    for domain, subfields in taxonomy.items():
        for sub in subfields:
            field_labels[sub] = humanize(sub)
            field_to_domain[sub] = domain
    return taxonomy, field_labels, field_to_domain


def count_merged_tasks(tree: list[dict[str, Any]]) -> dict[tuple[str, str], int]:
    """Count tasks/<domain>/<subfield>/<task>/task.toml on the default branch."""
    counts: dict[tuple[str, str], int] = {}
    for entry in tree:
        if entry.get("type") != "blob":
            continue
        path = entry.get("path", "")
        if not path.startswith("tasks/") or not path.endswith("/task.toml"):
            continue
        parts = path.split("/")
        if len(parts) != 5:
            continue
        _, domain, subfield, _task, _ = parts
        counts[(domain, subfield)] = counts.get((domain, subfield), 0) + 1
    return counts


# --- Field resolution per PR / proposal -------------------------------------

def field_from_pr_files(files: list[str], taxonomy: dict[str, dict[str, list[str]]]) -> tuple[str | None, str | None]:
    """Pick the (domain, subfield) implied by the file paths the PR touches.

    Looks for any path of shape `tasks/<domain>/<subfield>/...` where both
    levels match the discovered taxonomy. Returns the first match.
    """
    for p in files:
        parts = p.split("/")
        if len(parts) < 3 or parts[0] != "tasks":
            continue
        domain, subfield = parts[1], parts[2]
        if domain in taxonomy and subfield in taxonomy.get(domain, {}):
            return domain, subfield
    return None, None


def field_from_title_fallback(
    title: str,
    field_to_domain: dict[str, str],
) -> tuple[str | None, str | None, str | None]:
    """When the PR diff isn't available, fall back to the `[TASK: <field>]` prefix."""
    field_text = parse_field_from_title(title)
    if not field_text:
        return None, None, None
    slug = slugify(field_text)
    domain = field_to_domain.get(slug)
    return domain, (slug if domain else None), field_text


def field_from_proposal_body(
    body: str,
    field_to_domain: dict[str, str],
) -> tuple[str | None, str | None, str | None]:
    """Parse `## Scientific Domain\nLife Sciences > Biology > Microscopy`.

    Returns (domain, subfield, raw_field_text). The third element is the raw
    second-level segment ("Biology") so we can still show something useful when
    the segment isn't in the discovered taxonomy.
    """
    m = SCIENTIFIC_DOMAIN_RE.search(body or "")
    if not m:
        return None, None, None
    parts = [s.strip() for s in m.group(1).split(">")]
    if len(parts) < 2:
        return None, None, None
    domain_slug = slugify(parts[0])
    subfield_slug = slugify(parts[1])
    if subfield_slug in field_to_domain:
        return field_to_domain[subfield_slug], subfield_slug, parts[1]
    # Subfield not in taxonomy: still expose raw text so the UI can render a
    # muted chip. Domain only kept if it matches a known top-level slug.
    domain = domain_slug if domain_slug in {d for d in field_to_domain.values()} else None
    return domain, None, parts[1]


# --- GraphQL queries --------------------------------------------------------

PR_QUERY = """
query($owner:String!,$name:String!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequests(states:[OPEN,CLOSED,MERGED],first:50,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){
      pageInfo{ hasNextPage endCursor }
      nodes{
        number title url isDraft state mergedAt closedAt createdAt updatedAt
        author{ login ... on User { avatarUrl } }
        labels(first:30){ nodes{ name color } }
        reviewRequests(first:10){
          nodes{
            requestedReviewer{
              ... on User { login avatarUrl }
            }
          }
        }
        files(first:100){
          nodes{ path changeType }
        }
        commits(last:1){
          nodes{
            commit{
              statusCheckRollup{ state }
            }
          }
        }
      }
    }
  }
}
"""

DISCUSSION_QUERY = """
query($owner:String!,$name:String!,$cursor:String){
  repository(owner:$owner,name:$name){
    discussions(first:50,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){
      pageInfo{ hasNextPage endCursor }
      nodes{
        number title url body closed closedAt createdAt updatedAt
        category{ name }
        author{ login ... on User { avatarUrl } }
        labels(first:20){ nodes{ name } }
        comments(first:30){
          nodes{
            url
            author{ login }
            bodyText
          }
        }
      }
    }
  }
}
"""

# Detects the auto-posted LLM review's "Recommendation: 🟢 Recommended" line.
# Captures the emoji + word; emoji alone is enough to map to recommend/uncertain/reject.
LLM_RECOMMENDATION_RE = re.compile(
    r"Recommendation\s*:\s*(?P<emoji>🟢|🟡|🔴)\s*(?P<word>\w+)",
    re.IGNORECASE,
)
LLM_REVIEW_MARKERS = ("Task Proposal Rubric Review", "Rubric Review")
LLM_REVIEW_BOTS = {"github-actions", "github-actions[bot]"}


def parse_llm_review(comments: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Find the latest auto-posted rubric review comment on a discussion."""
    for c in reversed(comments):  # take the most recent matching
        author = (c.get("author") or {}).get("login", "")
        body = c.get("bodyText", "") or ""
        if author not in LLM_REVIEW_BOTS:
            continue
        if not any(m in body for m in LLM_REVIEW_MARKERS):
            continue
        m = LLM_RECOMMENDATION_RE.search(body)
        if not m:
            return {"recommendation": "unknown", "url": c.get("url")}
        emoji = m.group("emoji")
        rec = {"🟢": "accept", "🟡": "uncertain", "🔴": "reject"}.get(emoji, "unknown")
        return {"recommendation": rec, "url": c.get("url")}
    return None


def paged(query: str, key: str, max_pages: int | None = None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    cursor: str | None = None
    pages = 0
    while True:
        variables: dict[str, Any] = {"owner": UPSTREAM_OWNER, "name": UPSTREAM_NAME}
        if cursor:
            variables["cursor"] = cursor
        data = graphql(query, variables)
        block = data["data"]["repository"][key]
        out.extend(block["nodes"])
        pages += 1
        if not block["pageInfo"]["hasNextPage"]:
            break
        if max_pages is not None and pages >= max_pages:
            break
        cursor = block["pageInfo"]["endCursor"]
    return out


def build_prs(
    nodes: list[dict[str, Any]],
    now: datetime,
    taxonomy: dict[str, dict[str, list[str]]],
    field_to_domain: dict[str, str],
) -> list[dict[str, Any]]:
    rows = []
    for n in nodes:
        labels = [lab["name"] for lab in n["labels"]["nodes"]]
        # Source of truth = upstream labels. Mislabeled PRs are an upstream
        # issue to fix there, not here.
        if "new task" not in labels:
            continue
        file_nodes = n.get("files", {}).get("nodes", []) or []
        files = [f["path"] for f in file_nodes]

        # Priority 1: file paths in the PR. Priority 2: title prefix.
        files = [f["path"] for f in n.get("files", {}).get("nodes", []) or []]
        domain, subfield = field_from_pr_files(files, taxonomy)
        raw_field: str | None = None
        if not subfield:
            domain, subfield, raw_field = field_from_title_fallback(
                n["title"], field_to_domain
            )

        dri = None
        for rr in n["reviewRequests"]["nodes"]:
            r = rr.get("requestedReviewer")
            if r and r.get("login"):
                dri = {"login": r["login"], "avatar_url": r.get("avatarUrl")}
                break
        ci = None
        commits = n["commits"]["nodes"]
        if commits and commits[0]["commit"]["statusCheckRollup"]:
            ci = commits[0]["commit"]["statusCheckRollup"]["state"].lower()
        author = n.get("author") or {}
        state = (n.get("state") or "OPEN").lower()  # "open" | "closed" | "merged"
        rows.append({
            "number": n["number"],
            "title": n["title"],
            "url": n["url"],
            "is_draft": n["isDraft"],
            "state": state,
            "author": {
                "login": author.get("login", "ghost"),
                "avatar_url": author.get("avatarUrl"),
            },
            "domain": domain,
            "subfield": subfield,
            "field": raw_field,
            "review_stage": derive_review_stage(labels),
            "ball_in_court": derive_ball_in_court(labels) if state == "open" else None,
            "dri": dri if state == "open" else None,
            "age_days": age_days(n["createdAt"], now),
            "updated_days": age_days(n["updatedAt"], now),
            "merged_days": age_days(n["mergedAt"], now) if n.get("mergedAt") else None,
            "closed_days": age_days(n["closedAt"], now) if n.get("closedAt") else None,
            "ci": ci,
            "created_at": n["createdAt"],
            "updated_at": n["updatedAt"],
            "merged_at": n.get("mergedAt"),
            "closed_at": n.get("closedAt"),
            "labels": labels,
        })
    return rows


def build_proposals(
    nodes: list[dict[str, Any]],
    now: datetime,
    pr_titles: list[str],
    field_to_domain: dict[str, str],
) -> list[dict[str, Any]]:
    rows = []
    for n in nodes:
        if (n.get("category") or {}).get("name") != TASK_PROPOSAL_CATEGORY:
            continue
        labels = [lab["name"] for lab in n["labels"]["nodes"]]
        proposal_number, clean_title = parse_proposal_number(n["title"])

        domain, subfield, raw_field = field_from_proposal_body(
            n.get("body") or "", field_to_domain
        )
        if not subfield:
            d2, s2, r2 = field_from_title_fallback(clean_title or n["title"], field_to_domain)
            if s2:
                domain, subfield, raw_field = d2, s2, r2

        gh_author = n.get("author") or {}
        # Prefer the **Proposed by @handle** attribution backfilled into the
        # body — that's the original Airtable submitter. Fall back to the GH
        # discussion author when no attribution line is present.
        author_login: str = gh_author.get("login", "ghost")
        author_avatar: str | None = gh_author.get("avatarUrl")
        m = PROPOSED_BY_RE.search(n.get("body") or "")
        if m:
            author_login = m.group(1)
            author_avatar = f"https://github.com/{author_login}.png?size=80"
        has_pr = False
        if proposal_number is not None:
            needle = f"#{proposal_number}"
            has_pr = any(needle in t for t in pr_titles)

        llm_review = parse_llm_review(n.get("comments", {}).get("nodes", []) or [])
        status = derive_status(labels)
        # Three-way state for the proposals toggle: maintainer-approved beats
        # GH-closed (an approved proposal can be closed once its PR opens);
        # GH-closed otherwise means rejected/abandoned; everything else is open.
        if status == "approved":
            state = "approved"
        elif n.get("closed") or status == "rejected":
            state = "closed"
        else:
            state = "open"
        rows.append({
            "number": n["number"],
            "proposal_number": proposal_number,
            "title": clean_title or n["title"],
            "raw_title": n["title"],
            "url": n["url"],
            "author": {
                "login": author_login,
                "avatar_url": author_avatar,
            },
            "domain": domain,
            "subfield": subfield,
            "field": raw_field,
            "status": status,
            "state": state,
            "closed": bool(n.get("closed")),
            "llm_review": llm_review,
            "age_days": age_days(n["createdAt"], now),
            "updated_days": age_days(n["updatedAt"], now),
            "has_pr": has_pr,
            "created_at": n["createdAt"],
            "updated_at": n["updatedAt"],
            "closed_at": n.get("closedAt"),
            "labels": labels,
        })
    return rows


def build_coverage(
    prs: list[dict[str, Any]],
    proposals: list[dict[str, Any]],
    taxonomy: dict[str, dict[str, list[str]]],
    merged_counts: dict[tuple[str, str], int],
) -> dict[str, Any]:
    coverage: dict[str, dict[str, dict[str, int]]] = {}
    for domain, subfields in taxonomy.items():
        coverage[domain] = {
            sub: {"merged": 0, "in_review": 0, "proposed": 0} for sub in subfields
        }
        coverage[domain]["_unknown"] = {"merged": 0, "in_review": 0, "proposed": 0}

    for (domain, sub), n in merged_counts.items():
        if domain in coverage:
            key = sub if sub in coverage[domain] else "_unknown"
            coverage[domain][key]["merged"] += n

    for pr in prs:
        if pr.get("state") != "open":
            continue
        d, s = pr.get("domain"), pr.get("subfield")
        if d and d in coverage:
            key = s if s and s in coverage[d] else "_unknown"
            coverage[d][key]["in_review"] += 1
    for p in proposals:
        d, s = p.get("domain"), p.get("subfield")
        if d and d in coverage:
            key = s if s and s in coverage[d] else "_unknown"
            coverage[d][key]["proposed"] += 1
    return coverage


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="-", help="Output path (default: stdout)")
    args = ap.parse_args()

    now = datetime.now(timezone.utc)

    tree = fetch_tree()
    taxonomy, field_labels, field_to_domain = discover_taxonomy(tree)
    merged_counts = count_merged_tasks(tree)

    if not taxonomy:
        sys.stderr.write("No taxonomy discovered under tasks/ — aborting.\n")
        return 1

    # Make sure domain top-level slugs we know about are present even if the
    # repo doesn't yet have folders for them (defensive).
    for d in DOMAIN_LABEL_SET:
        taxonomy.setdefault(d, {})

    # Cap PR pages so closed/merged history doesn't bloat the payload. 8 pages
    # × 50 = up to 400 most-recently-updated PRs covering every open one plus
    # plenty of recent merges/closes.
    pr_nodes = paged(PR_QUERY, "pullRequests", max_pages=8)
    discussion_nodes = paged(DISCUSSION_QUERY, "discussions")

    prs = build_prs(pr_nodes, now, taxonomy, field_to_domain)
    proposals = build_proposals(
        discussion_nodes, now, [p["title"] for p in prs], field_to_domain
    )
    coverage = build_coverage(prs, proposals, taxonomy, merged_counts)

    payload = {
        "generated_at": now.isoformat(),
        "upstream": UPSTREAM,
        "taxonomy": taxonomy,
        "field_labels": field_labels,
        "field_to_domain": field_to_domain,
        "prs": prs,
        "proposals": proposals,
        "coverage": coverage,
        "stats": {
            "open_prs": sum(1 for p in prs if p["state"] == "open"),
            "merged_prs": sum(1 for p in prs if p["state"] == "merged"),
            "closed_prs": sum(1 for p in prs if p["state"] == "closed"),
            "open_proposals": sum(1 for p in proposals if p["state"] == "open"),
            "approved_proposals": sum(1 for p in proposals if p["state"] == "approved"),
            "closed_proposals": sum(1 for p in proposals if p["state"] == "closed"),
            "pending_proposals": sum(1 for p in proposals if p["status"] == "pending"),
            "needs_reviewer": sum(1 for p in prs if p["ball_in_court"] == "reviewer"),
            "needs_author": sum(1 for p in prs if p["ball_in_court"] == "author"),
        },
    }

    text = json.dumps(payload, indent=2)
    if args.out == "-":
        sys.stdout.write(text)
    else:
        with open(args.out, "w") as f:
            f.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

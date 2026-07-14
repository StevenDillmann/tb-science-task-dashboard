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
import time
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
    "engineering-sciences",
}

# Parallel review model: a "domain" reviewer and a "technical" reviewer review
# concurrently, then a "final" reviewer signs off after both approve. The UI
# renders a row of filled dots; review_stage is an opaque count-key derived
# from the actual reviewer statuses (see derive_review_stage) — NOT from the
# `… review ✅` labels, which drift out of sync.

# Only first-party reviews count as "reviewers" in the dashboard. Bot and
# drive-by reviews (Devin, Copilot, external commenters) come in as NONE or
# CONTRIBUTOR and are excluded — mirroring the upstream checks-passed.yml filter
# that drives reviewer assignment.
REVIEWER_ASSOCIATIONS = {"COLLABORATOR", "MEMBER", "OWNER"}

TASK_PROPOSAL_CATEGORY = "Task Proposals"

# Matches the structured "## Scientific Domain" section in proposal bodies.
SCIENTIFIC_DOMAIN_RE = re.compile(
    r"##\s*Scientific\s+Domain\s*\n+([^\n]+)", re.IGNORECASE
)

# Two ways to attribute a proposal to its original Airtable submitter rather
# than the GH account that posted the discussion on their behalf:
#
#   1. Legacy backfill at the top of the body: `**Proposed by @handle**`.
#   2. Current Airtable form: an `## Author Information` block at the bottom
#      with a `GitHub: https://github.com/<handle>` line.
PROPOSED_BY_RE = re.compile(
    r"\*\*\s*Proposed by\s*@([A-Za-z0-9-]+)\s*\*\*", re.IGNORECASE
)
# Accepts "GitHub: https://github.com/handle", "GitHub: github.com/handle"
# (no scheme), and bare "GitHub: handle". The scheme and host prefix are both
# optional so a single capture group yields the handle in every case —
# otherwise a scheme-less "github.com/handle" captures "github".
AUTHOR_GITHUB_RE = re.compile(
    r"GitHub\s*:\s*(?:(?:https?://)?github\.com/)?([A-Za-z0-9-]+)", re.IGNORECASE
)
# Form placeholders to ignore so we don't attribute a proposal to "None".
_GITHUB_PLACEHOLDERS = {"none", "n-a", "na"}
AUTHOR_NAME_RE = re.compile(r"^Author\s*:\s*(.+?)$", re.IGNORECASE | re.MULTILINE)


def parse_proposal_author(body: str) -> tuple[str | None, str | None]:
    """Return (login, display_name) for the original proposal submitter.

    Prefer the `Proposed by @handle` legacy line; otherwise pull the handle
    from a `GitHub: https://github.com/<handle>` line under
    `## Author Information`. `display_name` is the human name from the
    `Author:` field when present.
    """
    body = body or ""
    m = PROPOSED_BY_RE.search(body)
    if m:
        return m.group(1), None
    m = AUTHOR_GITHUB_RE.search(body)
    if m:
        handle = m.group(1)
        if handle.lower() in _GITHUB_PLACEHOLDERS:
            return None, None
        name_match = AUTHOR_NAME_RE.search(body)
        return handle, (name_match.group(1).strip() if name_match else None)
    return None, None


def gh(args: list[str], *, retries: int = 5) -> str:
    """Run a `gh` command, retrying transient API failures with backoff.

    The GitHub API intermittently returns a truncated/empty body (`gh` then
    exits non-zero with "unexpected end of JSON input") or drops the connection.
    A single such blip used to abort the whole fetch — and with ~40 calls per
    run, the hourly rebuild failed most of the time. Every call here expects a
    non-empty JSON body, so treat a non-zero exit OR empty stdout as transient
    and retry; only give up (and fail the run) after `retries` attempts.
    """
    delay = 2.0
    for attempt in range(retries + 1):
        res = subprocess.run(["gh", *args], capture_output=True, text=True, check=False)
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout
        if attempt < retries:
            sys.stderr.write(
                f"gh call failed (attempt {attempt + 1}/{retries + 1}, "
                f"rc={res.returncode}): {res.stderr.strip()[:200] or 'empty body'} "
                f"— retrying in {delay:.0f}s\n"
            )
            time.sleep(delay)
            delay = min(delay * 2, 30)
            continue
        sys.stderr.write(res.stderr)
        raise SystemExit(res.returncode or 1)
    raise SystemExit(1)  # unreachable


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


def derive_review_stage(reviewers: list[dict[str, Any]]) -> str:
    """Review progress as a count-key for the UI Stage dots.

    Derived ONLY from the `reviewers` list — the exact same data the Reviewer
    column renders — so the Stage dots can never disagree with the column.
    Labels are deliberately not consulted (they drift out of sync).

      "none" → 0 approvals · "1st" → 1 parallel · "2nd" → both parallel
      "3rd"  → final reviewer approved
    """
    if not reviewers:
        return "none"
    by_role = {r["role"]: r for r in reviewers if r.get("role")}
    if by_role:
        final = by_role.get("final")
        if final and final.get("status") == "approved":
            return "3rd"
        approvals = sum(
            1
            for role in ("domain", "technical")
            if (by_role.get(role) or {}).get("status") == "approved"
        )
        return {2: "2nd", 1: "1st"}.get(approvals, "none")
    # No role marker: count approvals among the reviewers directly.
    approvals = sum(1 for r in reviewers if r.get("status") == "approved")
    return {2: "2nd", 1: "1st"}.get(min(approvals, 2), "none")


def derive_ball_in_court(labels: list[str]) -> str | None:
    """Whose court the PR is in — taken straight from the GitHub workflow label.

    The `waiting on …` labels are the team's source of truth for whose turn it
    is, and they track the live state (e.g. an author reply flips the label
    even though the reviewer's stale CHANGES_REQUESTED review stays sticky).

    - "waiting on author"   → author
    - "waiting on reviewer" → reviewer
    - neither label present  → None
    """
    if "waiting on author" in labels:
        return "author"
    if "waiting on reviewer" in labels:
        return "reviewer"
    return None


# Map ball-in-court → the GitHub label whose most-recent application marks when
# the PR entered that state.
_BALL_LABEL = {"author": "waiting on author", "reviewer": "waiting on reviewer"}


def ball_since(node: dict[str, Any], ball: str | None) -> str | None:
    """When the PR last entered its current waiting-on state.

    Returns the ISO timestamp of the MOST RECENT `labeled` event for the ball's
    label (the labels toggle back and forth as the PR bounces between author and
    reviewer, so we want the latest application, not the first). None if the ball
    is unset or no matching label event is found.
    """
    label_name = _BALL_LABEL.get(ball or "")
    if not label_name:
        return None
    latest: str | None = None
    for it in (node.get("timelineItems", {}).get("nodes", []) or []):
        if it.get("__typename") != "LabeledEvent":
            continue
        if (it.get("label") or {}).get("name") != label_name:
            continue
        ts = it.get("createdAt")
        if ts and (latest is None or ts > latest):
            latest = ts
    return latest


# The CI dot mirrors the upstream checks-passed.yml gate: a PR's CI is "green"
# when the two MECHANICAL checks pass. Both are deterministic GitHub Actions
# jobs; the rubric review is an advisory LLM judgment (shown in its own column)
# and NO LONGER gates, so it must not turn the dot red. Matched by name prefix
# because execution-checks/rubric-review append the task path to the check name.
CI_GATE_CHECKS = ("static-checks", "execution-checks")


# Check-run conclusions that are genuine failures (red). Everything else that
# isn't a pass — cancelled / stale / neutral / none — is treated as "pending"
# (no verdict: aborted, superseded by a newer run, or n/a) rather than a
# failure, so an interrupted/cancelled run doesn't read as CI *failing*.
_CI_FAIL_CONCLUSIONS = {"FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"}


def _check_run_status(conclusion: str | None, status: str | None) -> str:
    """pass / fail / pending for one check-run.

    Incomplete → pending; success|skipped → pass; a genuine failure conclusion
    → fail; cancelled / stale / neutral / none → pending (no real verdict, e.g.
    a run cancelled by concurrency and never re-run to completion).
    """
    if (status or "").upper() != "COMPLETED":
        return "pending"
    c = (conclusion or "").upper()
    if c in ("SUCCESS", "SKIPPED"):
        return "pass"
    if c in _CI_FAIL_CONCLUSIONS:
        return "fail"
    return "pending"


def derive_ci(rollup: dict[str, Any] | None) -> str | None:
    """CI state for the dashboard dot, gating ONLY on the mechanical checks.

    "failure" if any mechanical check failed, "pending" if one is still running
    or hasn't started, "success" if every mechanical check that ran passed.
    Returns None when the commit carries none of the gate checks (nothing to
    show) — we deliberately do NOT fall back to the advisory-polluted rollup
    state.
    """
    if not rollup:
        return None
    contexts = (rollup.get("contexts", {}) or {}).get("nodes", []) or []
    # Latest run wins per gate (a re-run appends a newer CheckRun node), mirroring
    # the `jq 'last'` in checks-passed.yml.
    latest: dict[str, str] = {}
    for ctx in contexts:
        name = ctx.get("name")
        if not name:
            continue
        for gate in CI_GATE_CHECKS:
            if name.startswith(gate):
                latest[gate] = _check_run_status(ctx.get("conclusion"), ctx.get("status"))
    if not latest:
        return None
    statuses = latest.values()
    if any(s == "fail" for s in statuses):
        return "failure"
    if any(s == "pending" for s in statuses):
        return "pending"
    return "success"


def derive_type(labels: list[str]) -> str:
    for lab in ("task fix", "documentation", "new task"):
        if lab in labels:
            return lab
    return "other"


def derive_status(labels: list[str]) -> str:
    if "proposal-approved" in labels:
        return "approved"
    if "proposal-declined" in labels:
        return "rejected"
    return "pending"


# Hidden marker comment that records the slot→handle mapping for the parallel
# review model, e.g.
#   <!-- reviewer-slots: {"domain": "alice", "technical": "bob", "final": ""} -->
# Written by the upstream slot_marker.py. Absent on PRs predating that model.
# The "technical" slot was formerly named "general"; we still read that legacy
# key from older markers and normalise it to "technical".
REVIEWER_SLOTS_RE = re.compile(r"<!--\s*reviewer-slots:\s*(\{.*?\})\s*-->", re.DOTALL)


def parse_reviewer_slots(comments: list[dict[str, Any]]) -> dict[str, str]:
    """Return {login: role} from the latest reviewer-slots marker comment.

    role ∈ {"domain", "technical", "final"}. Empty/missing slots are skipped.
    A legacy "general" key is read as "technical". Returns {} when no marker is
    present (most pre-parallel-model PRs).
    """
    for c in reversed(comments):  # most recent marker wins
        m = REVIEWER_SLOTS_RE.search(c.get("body", "") or "")
        if not m:
            continue
        try:
            slots = json.loads(m.group(1))
        except json.JSONDecodeError:
            continue
        # Legacy "general" → "technical"; prefer the new key if both present.
        if "general" in slots and "technical" not in slots:
            slots["technical"] = slots.pop("general")
        out: dict[str, str] = {}
        for role in ("domain", "technical", "final"):
            handle = (slots.get(role) or "").strip()
            if handle:
                out[handle] = role
        return out
    return {}


def build_reviewers(
    node: dict[str, Any], roles: dict[str, str] | None = None
) -> list[dict[str, Any]]:
    """Per-reviewer status for a PR: approved / changes_requested / pending.

    The reviewer list is the PR's **assignees** — the workflow assigns exactly
    the people responsible for the PR (the two parallel reviewers up front, then
    the final reviewer once both approve). This is the stable source of "who is
    the reviewer": GitHub drops people from `reviewRequests` on approval, and the
    raw `reviews` list includes drive-by commenters who aren't reviewers. We take
    the assignees and label each with the status from their own latest *terminal*
    review (APPROVED / CHANGES_REQUESTED), defaulting to `pending` when they
    haven't submitted one yet.

    Only COLLABORATOR/MEMBER/OWNER reviews count (REVIEWER_ASSOCIATIONS); bot and
    drive-by reviews never affect status.

    Status = whose court the ball is in for this reviewer's slot:
      - approved           → satisfied (green)
      - changes_requested  → reviewer wants changes; ball on the AUTHOR (red)
      - pending            → ball on the REVIEWER (amber)

    A re-request is GitHub's authoritative "ball is back with the reviewer"
    signal: a reviewer in `reviewRequests` is being awaited again (the author
    has since responded / re-requested), so their prior review — approval OR
    changes-request — no longer holds and they show as `pending`.
    """
    # Latest terminal review state per first-party author (last wins). Used only
    # to label the assignees below — a review by a non-assignee is ignored.
    review_status: dict[str, str] = {}
    review_avatars: dict[str, str | None] = {}
    for r in node.get("reviews", {}).get("nodes", []) or []:
        if r.get("authorAssociation") not in REVIEWER_ASSOCIATIONS:
            continue
        author = r.get("author") or {}
        login = author.get("login")
        if not login:
            continue
        review_avatars[login] = author.get("avatarUrl") or review_avatars.get(login)
        state = r.get("state")
        if state == "APPROVED":
            review_status[login] = "approved"
        elif state == "CHANGES_REQUESTED":
            review_status[login] = "changes_requested"

    # Currently re-requested reviewers — their prior review is stale; treat as
    # pending regardless of any earlier terminal review.
    re_requested = {
        rr["requestedReviewer"]["login"]
        for rr in (node.get("reviewRequests", {}).get("nodes", []) or [])
        if (rr.get("requestedReviewer") or {}).get("login")
    }

    # The reviewers ARE the assignees. Label each with their review status.
    status: dict[str, str] = {}
    avatars: dict[str, str | None] = {}
    order: list[str] = []
    for a in node.get("assignees", {}).get("nodes", []) or []:
        login = a.get("login")
        if not login or login in status:
            continue
        order.append(login)
        avatars[login] = a.get("avatarUrl") or review_avatars.get(login)
        # Re-request wins: ball is back with the reviewer regardless of their
        # prior (now superseded) review. Otherwise use their latest review.
        if login in re_requested:
            status[login] = "pending"
        else:
            status[login] = review_status.get(login, "pending")

    # Role comes from the hidden slot marker (domain/technical/final) where the
    # PR has one; None otherwise. Always display in slot order:
    # domain → technical → final (then any unknown-role reviewers), so the cell
    # reads consistently regardless of who approved first.
    roles = roles or {}
    _role_order = {"domain": 0, "technical": 1, "final": 2}

    out = [
        {
            "login": login,
            "avatar_url": avatars.get(login),
            "status": status.get(login, "pending"),
            "role": roles.get(login),
        }
        for login in order
    ]
    out.sort(
        key=lambda u: (
            _role_order.get(u["role"], 3),
            u["login"].lower(),
        )
    )
    return out


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

def build_task_location_map(tree: list[dict[str, Any]]) -> dict[str, tuple[str, str]]:
    """Map task-folder-name → (domain, subfield) from the live tree.

    Used to recover the current home of a task that a (now-merged) PR touched
    under a folder that has since been renamed or split.
    """
    out: dict[str, tuple[str, str]] = {}
    for entry in tree:
        if entry.get("type") != "tree":
            continue
        parts = entry.get("path", "").split("/")
        if len(parts) == 4 and parts[0] == "tasks":
            out[parts[3]] = (parts[1], parts[2])
    return out


# Legacy subfield folder names that no longer exist in the live taxonomy.
# Maps (domain, legacy-subfield) → canonical (domain, subfield). When the
# upstream taxonomy gets reshaped, add an entry here so PRs filed against the
# old layout still get categorized correctly.
LEGACY_SUBFIELD_ALIASES: dict[tuple[str, str], tuple[str, str]] = {
    ("physical-sciences", "chemistry-and-materials"): ("physical-sciences", "materials-science"),
    ("physical-sciences", "material-science"): ("physical-sciences", "materials-science"),
    ("physical-sciences", "pde"): ("mathematical-sciences", "applied-mathematics"),
    ("mathematical-sciences", "data-science-and-statistics"): ("mathematical-sciences", "statistics"),
    ("mathematical-sciences", "others"): ("mathematical-sciences", "applied-mathematics"),
    ("earth-sciences", "water-sciences"): ("earth-sciences", "ocean-sciences"),
    # 2026 math reshape: scientific-computing folded into a broadened
    # applied-mathematics; autoformalization renamed to formal-mathematics.
    ("mathematical-sciences", "scientific-computing"): ("mathematical-sciences", "applied-mathematics"),
    ("mathematical-sciences", "autoformalization"): ("mathematical-sciences", "formal-mathematics"),
}

# Per-proposal taxonomy fixups for the 2026 "Other Sciences" → engineering-sciences
# migration. The old Engineering / Interdisciplinary / Miscellaneous Sciences
# fields have no 1:1 successor, so each stranded proposal is routed to its new
# home by topic (see the taxonomy change in the upstream repo). Keyed by GitHub
# discussion number. Wins over the parsed/aliased field.
PROPOSAL_FIELD_OVERRIDES: dict[int, tuple[str, str]] = {
    # Other Sciences > Engineering Sciences — routed to a new engineering field
    520: ("engineering-sciences", "mechanical-engineering"),  # Robotics
    514: ("engineering-sciences", "mechanical-engineering"),  # Robotics
    519: ("engineering-sciences", "mechanical-engineering"),  # Robotics
    518: ("engineering-sciences", "mechanical-engineering"),  # Robotics
    517: ("engineering-sciences", "mechanical-engineering"),  # Robot manipulation
    380: ("engineering-sciences", "mechanical-engineering"),  # Aerospace / hydrodynamic stability
    561: ("engineering-sciences", "electrical-engineering"),  # Wireless communications
    336: ("engineering-sciences", "electrical-engineering"),  # Power systems
    484: ("engineering-sciences", "electrical-engineering"),  # Renewable energy systems
    373: ("engineering-sciences", "electrical-engineering"),  # Software engineering
    512: ("engineering-sciences", "electrical-engineering"),  # Security policy verification
    # Interdisciplinary / Miscellaneous Sciences — no successor field; routed per
    # maintainer decision (ML/futures → electrical, RNA-seq → life sciences).
    186: ("engineering-sciences", "electrical-engineering"),  # ML benchmarking
    225: ("engineering-sciences", "electrical-engineering"),  # ML reproduction
    194: ("engineering-sciences", "electrical-engineering"),  # futures research
    355: ("life-sciences", "biology"),                        # RNA-seq workflow reproducibility
}


def field_from_pr_files(
    files: list[str],
    taxonomy: dict[str, dict[str, list[str]]],
    task_locations: dict[str, tuple[str, str]] | None = None,
) -> tuple[str | None, str | None]:
    """Pick the (domain, subfield) implied by the file paths the PR touches.

    Priority order:
      1. Direct match against the live taxonomy.
      2. Lookup the task folder name in the current tree (rename recovery —
         the most accurate signal for merged-then-moved tasks).
      3. Legacy subfield alias for unmerged PRs whose folder was renamed.
    """
    for p in files:
        parts = p.split("/")
        if len(parts) < 3 or parts[0] != "tasks":
            continue
        domain, subfield = parts[1], parts[2]
        if domain in taxonomy and subfield in taxonomy.get(domain, {}):
            return domain, subfield
    if task_locations:
        for p in files:
            parts = p.split("/")
            if len(parts) < 4 or parts[0] != "tasks":
                continue
            loc = task_locations.get(parts[3])
            if loc and loc[0] in taxonomy and loc[1] in taxonomy.get(loc[0], {}):
                return loc
    for p in files:
        parts = p.split("/")
        if len(parts) < 3 or parts[0] != "tasks":
            continue
        alias = LEGACY_SUBFIELD_ALIASES.get((parts[1], parts[2]))
        if alias and alias[0] in taxonomy and alias[1] in taxonomy.get(alias[0], {}):
            return alias
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
    # Remap subfields renamed by an upstream taxonomy reshape so proposals filed
    # against the old layout still land in the right field (same table the PR
    # file-path resolver uses).
    domain_slug, subfield_slug = LEGACY_SUBFIELD_ALIASES.get(
        (domain_slug, subfield_slug), (domain_slug, subfield_slug)
    )
    if subfield_slug in field_to_domain:
        return field_to_domain[subfield_slug], subfield_slug, humanize(subfield_slug)
    # Subfield not in taxonomy: still expose raw text so the UI can render a
    # muted chip. Domain only kept if it matches a known top-level slug.
    domain = domain_slug if domain_slug in {d for d in field_to_domain.values()} else None
    return domain, None, parts[1]


# --- GraphQL queries --------------------------------------------------------

PR_QUERY = """
query($owner:String!,$name:String!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequests(states:[OPEN,CLOSED,MERGED],first:25,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){
      pageInfo{ hasNextPage endCursor }
      nodes{
        number title url isDraft state mergedAt closedAt createdAt updatedAt
        bodyText body headRefOid
        author{ login ... on User { avatarUrl } }
        labels(first:30){ nodes{ name color } }
        # Label-add history, newest last. Used to measure how long a PR has sat
        # in its current `waiting on author` / `waiting on reviewer` state (the
        # most recent time that label was applied), so stale hand-offs surface.
        timelineItems(last:60, itemTypes:[LABELED_EVENT]){
          nodes{
            __typename
            ... on LabeledEvent { createdAt label{ name } }
          }
        }
        reviewRequests(first:10){
          nodes{
            requestedReviewer{
              ... on User { login avatarUrl }
            }
          }
        }
        assignees(first:10){
          nodes{ login avatarUrl }
        }
        reviews(last:50){
          nodes{
            author{ login ... on User { avatarUrl } }
            state
            authorAssociation
          }
        }
        files(first:100){
          nodes{ path changeType }
        }
        commits(last:1){
          nodes{
            commit{
              # We derive the CI dot from the individual mechanical checks
              # (see derive_ci), NOT the rollup state — the rollup flips to
              # FAILURE on any failing/cancelled context, including the advisory
              # rubric-review and cancelled `ping` no-ops.
              statusCheckRollup{
                state
                contexts(first:100){
                  nodes{
                    __typename
                    ... on CheckRun { name conclusion status }
                    ... on StatusContext { context state }
                  }
                }
              }
            }
          }
        }
        # Full comment timeline (paged past 100 by backfill_pr_comments). The
        # result parsers scan newest-first for the latest /run trial/cheat/rubric
        # comments, while the reviewer-slots marker is an EARLY comment — a fixed
        # `last:N` / `first:N` window truncates one end or the other, so we take
        # the whole list and never guess where the comment we need landed.
        comments(first:100){
          pageInfo{ hasNextPage endCursor }
          nodes{
            url
            author{ login }
            body
            bodyText
          }
        }
      }
    }
  }
}
"""


# Page through a single PR's remaining comments when it has more than the 100
# the PR_QUERY pulls in one shot. Keeps `comments.nodes` chronological.
PR_COMMENTS_QUERY = """
query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      comments(first:100,after:$cursor){
        pageInfo{ hasNextPage endCursor }
        nodes{
          url
          author{ login }
          body
          bodyText
        }
      }
    }
  }
}
"""


def backfill_pr_comments(nodes: list[dict[str, Any]]) -> None:
    """Ensure every PR node carries its COMPLETE comment timeline.

    PR_QUERY fetches the first 100 comments per PR. On the rare high-traffic PR
    with more than that, page through the rest so the /run result parsers (which
    scan newest-first) and the reviewer-slots marker (an early comment) both see
    the full list rather than a truncated window. Mutates `nodes` in place.
    """
    backfilled = 0
    for n in nodes:
        conn = n.get("comments", {})
        page = conn.get("pageInfo", {}) or {}
        if not page.get("hasNextPage"):
            continue
        cursor = page.get("endCursor")
        while cursor:
            data = graphql(PR_COMMENTS_QUERY, {
                "owner": UPSTREAM_OWNER,
                "name": UPSTREAM_NAME,
                "number": n["number"],
                "cursor": cursor,
            })
            block = data["data"]["repository"]["pullRequest"]["comments"]
            conn["nodes"].extend(block["nodes"])
            if not block["pageInfo"]["hasNextPage"]:
                break
            cursor = block["pageInfo"]["endCursor"]
        backfilled += 1
    if backfilled:
        sys.stderr.write(f"Backfilled comments for {backfilled} high-traffic PR(s).\n")


TRIAL_HEADER = "Agent Trial Results"
# The auto-posted job-summary line has the canonical totals, e.g. "0 of 8
# trials passed". Counting raw emojis in the comment body double-counts the
# per-criterion sub-tables; this is the reliable signal.
TRIAL_SUMMARY_RE = re.compile(
    r"(\d+)\s*(?:of|/)\s*(\d+)\s+trials?\s+passed",
    re.IGNORECASE,
)

CHEAT_HEADER = "Cheating Agent Trial Results"
# In the cheat comment ✅ means the cheat SUCCEEDED (bad) and ❌ means the
# cheat was blocked (good). We're after a robust per-row "X of Y cheats
# blocked" view, so count ✅ = succeeded and ❌ = blocked across the trial
# table. Same caveat as trials about the per-criterion sub-tables — we slice
# to just the top trial table by stopping at "Job Analysis" / "Overall Results".


def _slice_trial_table(body: str) -> str:
    """Return only the section between the header line and the first analysis
    section, to avoid counting emojis in per-criterion breakdowns.
    """
    end_markers = ("Job Analysis", "Overall Results", "Common Patterns", "Failure Pattern")
    earliest = len(body)
    for m in end_markers:
        idx = body.find(m)
        if idx != -1 and idx < earliest:
            earliest = idx
    return body[:earliest]

RUBRIC_HEADER = "Task Implementation Rubric Review"

# Authors use a variety of patterns to link a PR back to its source proposal:
#   - "Task Proposal #145"            → task-proposal-number form
#   - "approved task proposal 145"    → ditto, no `#`
#   - "https://github.com/.../discussions/291" → discussion-number URL
#   - Under a `## Task Proposal` section: bare `#291` (discussion-number form,
#     GitHub auto-links these so the explicit URL isn't needed in the body)
#   - "approved proposal: #244"       → discussion-number form
LINK_DISCUSSION_URL_RE = re.compile(
    r"discussions?/(\d+)", re.IGNORECASE
)
PROPOSAL_SECTION_RE = re.compile(
    r"(?:task\s+)?proposal", re.IGNORECASE
)
HASH_NUM_RE = re.compile(r"#(\d+)")
PLAIN_NUM_RE = re.compile(r"task\s+proposal\s*#?\s*(\d+)", re.IGNORECASE)


def find_linked_proposal(
    pr_title: str,
    pr_body: str,
    proposals_by_num: dict[int, dict[str, Any]],
    proposals_by_discussion: dict[int, dict[str, Any]],
) -> dict[str, Any] | None:
    """Find the source proposal a PR references. Tries, in order:

    1. A `discussions/<N>` URL anywhere in title or body.
    2. A `task proposal #N` style mention (matches by task-proposal number).
    3. A `#N` reference within ~300 chars after the first `Task Proposal`
       mention — N matched against discussion numbers, then proposal numbers.
    """
    hay = f"{pr_title}\n{pr_body or ''}"

    # 1. Discussion URL — most precise.
    m = LINK_DISCUSSION_URL_RE.search(hay)
    if m:
        n = int(m.group(1))
        if n in proposals_by_discussion:
            return proposals_by_discussion[n]

    # 2. "Task Proposal #145" style — matches task-proposal number.
    m = PLAIN_NUM_RE.search(hay)
    if m:
        n = int(m.group(1))
        if n in proposals_by_num:
            return proposals_by_num[n]
        # Some authors write the discussion number after "task proposal" too
        # (e.g. `link to the approved task proposal: #265`).
        if n in proposals_by_discussion:
            return proposals_by_discussion[n]

    # 3. Bare `#N` near a "Task Proposal" section header. Limit to the window
    #    just after the header so we don't accidentally grab unrelated `#N`
    #    references (issue/PR numbers, etc.).
    section = PROPOSAL_SECTION_RE.search(hay)
    if section:
        window = hay[section.end() : section.end() + 300]
        for hm in HASH_NUM_RE.finditer(window):
            n = int(hm.group(1))
            if n in proposals_by_discussion:
                return proposals_by_discussion[n]
            if n in proposals_by_num:
                return proposals_by_num[n]
    return None
RUBRIC_PASSED_RE = re.compile(r"(\d+)\s+passed\s+criteria", re.IGNORECASE)
RUBRIC_FAILED_RE = re.compile(r"(\d+)\s+failed\s+criteria", re.IGNORECASE)
RUBRIC_WARNING_RE = re.compile(r"(\d+)\s+warning\s+criteria", re.IGNORECASE)


def parse_rubric_review(comments: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Scan PR comments for the latest `📋 Task Implementation Rubric Review`
    and read the "X passed criteria" / "Y failed criteria" summary lines.
    """
    for c in reversed(comments):
        author = (c.get("author") or {}).get("login", "")
        body = c.get("bodyText", "") or ""
        if author not in LLM_REVIEW_BOTS:
            continue
        if RUBRIC_HEADER not in body:
            continue
        p = RUBRIC_PASSED_RE.search(body)
        f = RUBRIC_FAILED_RE.search(body)
        w = RUBRIC_WARNING_RE.search(body)
        passed = int(p.group(1)) if p else 0
        failed = int(f.group(1)) if f else 0
        warning = int(w.group(1)) if w else 0
        total = passed + failed + warning
        if total == 0:
            continue
        return {
            "passed": passed,
            "failed": failed,
            "warning": warning,
            "total": total,
            "url": c.get("url"),
        }
    return None


def parse_cheat_results(comments: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Scan PR comments for the latest `🔓 Cheating Agent Trial Results`.

    Parses the table the same way as `parse_trial_results`, but the cell
    semantics are inverted: ✅ in a cheat row means the cheat *succeeded*
    (bad), ❌ means the cheat was *blocked* (good).
    """
    for c in reversed(comments):
        author = (c.get("author") or {}).get("login", "")
        body_text = c.get("bodyText", "") or ""
        body_md = c.get("body", "") or ""
        if author not in LLM_REVIEW_BOTS:
            continue
        if CHEAT_HEADER not in body_text:
            continue
        top = _slice_trial_table(body_text)
        succeeded = top.count("✅")
        blocked = top.count("❌")
        total = succeeded + blocked
        if total == 0:
            continue

        by_model: list[dict[str, Any]] = []
        header_idx = body_md.find(CHEAT_HEADER)
        if header_idx >= 0:
            tail = body_md[header_idx:]
            in_table = False
            header_seen = False
            for line in tail.splitlines():
                if line.startswith("|"):
                    in_table = True
                    if "---" in line:
                        header_seen = True
                        continue
                    if not header_seen:
                        continue
                    cells = [c.strip() for c in line.strip("|").split("|")]
                    if len(cells) < 2:
                        continue
                    model_label = cells[0]
                    display = re.sub(r"`", "", model_label).split("<br>")[0].strip()
                    results: list[str] = []
                    for cell in cells[1:]:
                        c_clean = cell.strip()
                        if "✅" in c_clean:
                            results.append("succeeded")
                        elif "❌" in c_clean:
                            results.append("blocked")
                        else:
                            results.append("none")
                    if results:
                        by_model.append({
                            "model": _classify_model(model_label),
                            "display": display,
                            "results": results,
                        })
                elif in_table:
                    break

        return {
            "succeeded": succeeded,
            "blocked": blocked,
            "total": total,
            "by_model": by_model,
            "url": c.get("url"),
        }
    return None


def _classify_model(text: str) -> str:
    t = text.lower()
    if "claude" in t:
        return "claude"
    # Check gemini before gpt/openai: Gemini is routed through the openai/
    # provider (model id `openai/gemini-3.1-pro-preview`), so the label contains
    # "openai" and would otherwise be misclassified as gpt.
    if "gemini" in t or "google" in t:
        return "gemini"
    if "gpt" in t or "openai" in t:
        return "gpt"
    return "other"


def parse_trial_results(comments: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Scan PR comments for the latest `🧪 Agent Trial Results` post and
    extract both the summary totals AND the per-model trial breakdown.

    The markdown body has a leading table of the shape:

        | Model (Agent) | Trial 1 | Trial 2 | ... |
        | claude...     | ❌      | ✅      | ... |
        | gpt-5.5...    | ✅      | ❌      | ... |

    Each row is one model; each column past the first is one trial. We pull
    each model's results out into a `by_model` list so the UI can render a
    grid of dots, one row per model.
    """
    for c in reversed(comments):
        author = (c.get("author") or {}).get("login", "")
        body_text = c.get("bodyText", "") or ""
        body_md = c.get("body", "") or ""
        if author not in LLM_REVIEW_BOTS:
            continue
        if TRIAL_HEADER not in body_text:
            continue
        # The cheat comment's header ("Cheating Agent Trial Results") CONTAINS
        # the trial header, so skip it here — otherwise the latest cheat run gets
        # mistaken for the latest /run and the Trials column shows cheat data.
        if CHEAT_HEADER in body_text:
            continue
        # Parse the first markdown table after the trial header. We tally verdict
        # cells (✅ pass / ❌ fail / ⚠️ errored) as we go so we can DERIVE the
        # pass/total counts when the comment omits the "X of Y trials passed"
        # summary line — single-trial and all-errored runs don't emit it, but the
        # table is always present. Deriving keeps the latest /run visible instead
        # of silently falling back to an older run that happened to have a summary.
        by_model: list[dict[str, Any]] = []
        cell_pass = 0
        cell_verdict = 0  # pass + fail + errored — the count of attempted trials
        header_idx = body_md.find("Agent Trial Results")
        if header_idx >= 0:
            tail = body_md[header_idx:]
            # First non-trivial table is the trial table.
            # Split on lines, pick the first `|...|` block.
            in_table = False
            header_seen = False
            for line in tail.splitlines():
                if line.startswith("|"):
                    if not in_table:
                        in_table = True
                    if "---" in line:
                        header_seen = True
                        continue
                    if not header_seen:
                        continue
                    cells = [x.strip() for x in line.strip("|").split("|")]
                    if len(cells) < 2:
                        continue
                    model_label = cells[0]
                    # Trim leading backticks etc. and grab a short readable
                    # display name (first chunk before parens/backticks).
                    display = re.sub(r"`", "", model_label)
                    display = display.split("<br>")[0].strip()
                    results: list[str] = []
                    for cell in cells[1:]:
                        c_clean = cell.strip()
                        if "✅" in c_clean:
                            results.append("pass")
                            cell_pass += 1
                            cell_verdict += 1
                        elif "❌" in c_clean:
                            results.append("fail")
                            cell_verdict += 1
                        elif "⚠" in c_clean:
                            # Errored/incomplete trial. Rendered as a warning by
                            # the UI (its "none" branch); still an attempt, so it
                            # counts toward the derived total.
                            results.append("none")
                            cell_verdict += 1
                        else:
                            results.append("none")  # blank placeholder cell
                    if results:
                        by_model.append({
                            "model": _classify_model(model_label),
                            "display": display,
                            "results": results,
                        })
                elif in_table:
                    # First non-pipe line after entering the table = table end.
                    break

        # The auto-posted summary line is authoritative when present; otherwise
        # fall back to the counts derived from the table above.
        m = TRIAL_SUMMARY_RE.search(body_text)
        if m:
            passed, total = int(m.group(1)), int(m.group(2))
        else:
            passed, total = cell_pass, cell_verdict
        # total == 0 means no verdicts to show — most importantly this skips the
        # "🧪 Agent Trial Results ⏳" sticky placeholder posted while a run is
        # still in progress (header but empty table), so we keep showing the
        # last COMPLETED run until the new one finishes and fills its table in.
        if total == 0:
            continue

        return {
            "passed": passed,
            "total": total,
            "by_model": by_model,
            "url": c.get("url"),
        }
    return None

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
            createdAt
            author{ login ... on User { avatarUrl } }
            body
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
    task_locations: dict[str, tuple[str, str]] | None = None,
    proposals: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    proposals_by_num: dict[int, dict[str, Any]] = {}
    proposals_by_discussion: dict[int, dict[str, Any]] = {}
    for p in proposals or []:
        if p.get("proposal_number") is not None:
            proposals_by_num[p["proposal_number"]] = p
        proposals_by_discussion[p["number"]] = p

    # First pass: collect `task fix` PRs and group them by the task directory
    # they touch. This lets us attach a `fixes` list to each `new task` PR row
    # without showing fix PRs as standalone entries in the dashboard.
    fixes_by_task_dir: dict[str, list[dict[str, Any]]] = {}
    for n in nodes:
        labels = [lab["name"] for lab in n["labels"]["nodes"]]
        if "task fix" not in labels:
            continue
        files = [f["path"] for f in (n.get("files", {}).get("nodes", []) or [])]
        fix_task_dir: str | None = None
        for path in files:
            parts = path.split("/")
            if len(parts) >= 5 and parts[0] == "tasks":
                fix_task_dir = "/".join(parts[:4])
                break
        if not fix_task_dir:
            continue
        fixes_by_task_dir.setdefault(fix_task_dir, []).append({
            "number": n["number"],
            "title": n["title"],
            "url": n["url"],
            "state": (n.get("state") or "OPEN").lower(),
            "merged_at": n.get("mergedAt"),
            "closed_at": n.get("closedAt"),
            "created_at": n["createdAt"],
            "author": {
                "login": (n.get("author") or {}).get("login", "ghost"),
                "avatar_url": (n.get("author") or {}).get("avatarUrl"),
            },
        })

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
        domain, subfield = field_from_pr_files(files, taxonomy, task_locations)

        # Find the task directory the PR adds (for the side-panel previewer):
        # the first `tasks/<domain>/<subfield>/<task>/` containing a task.toml.
        task_dir: str | None = None
        for f in file_nodes:
            path = f.get("path", "")
            if f.get("changeType") == "ADDED" and path.endswith("/task.toml"):
                parts = path.split("/")
                if len(parts) == 5 and parts[0] == "tasks":
                    task_dir = "/".join(parts[:4])
                    break
        if not task_dir:
            for path in files:
                if path.endswith("/task.toml"):
                    parts = path.split("/")
                    if len(parts) == 5 and parts[0] == "tasks":
                        task_dir = "/".join(parts[:4])
                        break
        raw_field: str | None = None
        if not subfield:
            domain, subfield, raw_field = field_from_title_fallback(
                n["title"], field_to_domain
            )

        # In the parallel review model a PR has multiple reviewers at once
        # (a domain reviewer + a technical reviewer, then a final reviewer).
        # Collect everyone with an active review request; fall back to the
        # assignees when GitHub has dropped the request after a submitted
        # review. De-duped, order preserved. `dri` keeps the first for any
        # single-reviewer consumers; `dris` is the full list for display.
        dris = []
        seen = set()
        for rr in n["reviewRequests"]["nodes"]:
            r = rr.get("requestedReviewer")
            if r and r.get("login") and r["login"] not in seen:
                seen.add(r["login"])
                dris.append({"login": r["login"], "avatar_url": r.get("avatarUrl")})
        if not dris:
            for a in n.get("assignees", {}).get("nodes", []):
                if a.get("login") and a["login"] not in seen:
                    seen.add(a["login"])
                    dris.append({"login": a["login"], "avatar_url": a.get("avatarUrl")})
        dri = dris[0] if dris else None
        commits = n["commits"]["nodes"]
        rollup = commits[0]["commit"]["statusCheckRollup"] if commits else None
        ci = derive_ci(rollup)
        author = n.get("author") or {}
        state = (n.get("state") or "OPEN").lower()  # "open" | "closed" | "merged"
        comments = n.get("comments", {}).get("nodes", []) or []
        # Per-reviewer status (approved / pending / changes), with role pulled
        # from the hidden reviewer-slots marker where the PR has one. `comments`
        # is the complete timeline (see backfill_pr_comments), so the most-recent
        # marker wins ("most recent wins") without any windowing games.
        reviewer_roles = parse_reviewer_slots(comments)
        # `reviewers` is the single source of truth for the Reviewer column,
        # the Stage dots, and ball-in-court. We surface reviewers for open AND
        # merged PRs — a merged PR's approvals are worth showing (the Stage dots
        # light up green for the reviews that carried it in). Only `closed`
        # (abandoned) PRs are blanked, since their review history isn't
        # meaningful. Stage/ball then derive from the SAME list the column
        # shows, and can never disagree with it.
        reviewers = build_reviewers(n, reviewer_roles) if state != "closed" else []
        trials = parse_trial_results(comments)
        rubric = parse_rubric_review(comments)
        cheat = parse_cheat_results(comments)
        linked = find_linked_proposal(
            n["title"], n.get("bodyText") or "", proposals_by_num, proposals_by_discussion
        )
        linked_proposal = (
            {
                "proposal_number": linked["proposal_number"],
                "discussion_number": linked["number"],
                "title": linked["title"],
                "url": linked["url"],
            }
            if linked
            else None
        )
        # Whose court + how long it's been there (only meaningful for open PRs).
        ball = derive_ball_in_court(labels) if state == "open" else None
        ball_at = ball_since(n, ball)
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
            "review_stage": derive_review_stage(reviewers),
            # Only open PRs are "waiting on" anyone. Merged/closed PRs often keep
            # a stale `waiting on author` label, and leaving ball_in_court set
            # (a) miscounts them in needs_author/needs_reviewer and (b) makes the
            # Stage chip fall back to painting both parallel dots "changes
            # requested" (reviewers is already [] for non-open PRs). Blank it,
            # matching the dri/dris/reviewers treatment below.
            "ball_in_court": ball,
            # When the PR last entered its current waiting state, and how many
            # days ago — so reviewers/authors can be nudged on stale hand-offs.
            "ball_since": ball_at,
            "ball_days": age_days(ball_at, now) if ball_at else None,
            "dri": dri if state == "open" else None,
            "dris": dris if state == "open" else [],
            "reviewers": reviewers,  # already [] for non-open PRs
            "age_days": age_days(n["createdAt"], now),
            "updated_days": age_days(n["updatedAt"], now),
            "merged_days": age_days(n["mergedAt"], now) if n.get("mergedAt") else None,
            "closed_days": age_days(n["closedAt"], now) if n.get("closedAt") else None,
            "ci": ci,
            "trials": trials,
            "rubric": rubric,
            "cheat": cheat,
            "linked_proposal": linked_proposal,
            "body": n.get("body") or "",
            "head_sha": n.get("headRefOid"),
            "task_dir": task_dir,
            # Every file path inside the PR's task directory (relative paths)
            # so the side panel can list tests/ and solution/ contents.
            "task_files": (
                sorted(
                    f[len(task_dir) + 1 :]
                    for f in files
                    if task_dir and f.startswith(f"{task_dir}/")
                )
                if task_dir
                else []
            ),
            "created_at": n["createdAt"],
            "updated_at": n["updatedAt"],
            "merged_at": n.get("mergedAt"),
            "closed_at": n.get("closedAt"),
            "labels": labels,
            "fixes": sorted(
                fixes_by_task_dir.get(task_dir, []) if task_dir else [],
                key=lambda f: f["number"],
            ),
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
        # Manual per-proposal routing for legacy fields with no automatic
        # successor (Other-Sciences → engineering-sciences migration). Wins over
        # whatever the body/title produced.
        override = PROPOSAL_FIELD_OVERRIDES.get(n["number"])
        if override:
            domain, subfield = override
            raw_field = humanize(subfield)

        gh_author = n.get("author") or {}
        author_login: str = gh_author.get("login", "ghost")
        author_avatar: str | None = gh_author.get("avatarUrl")
        attributed_login, _attributed_name = parse_proposal_author(n.get("body") or "")
        if attributed_login:
            author_login = attributed_login
            author_avatar = f"https://github.com/{author_login}.png?size=80"
        has_pr = False
        if proposal_number is not None:
            needle = f"#{proposal_number}"
            has_pr = any(needle in t for t in pr_titles)

        llm_review = parse_llm_review(n.get("comments", {}).get("nodes", []) or [])
        # Human-review status is purely label-driven — a GH-closed discussion
        # without an explicit `proposal-declined` label stays `pending` (it
        # just lives in the Closed state-pill bucket).
        status = derive_status(labels)
        state = "closed" if n.get("closed") else "open"
        rows.append({
            "number": n["number"],
            "proposal_number": proposal_number,
            "title": clean_title or n["title"],
            "raw_title": n["title"],
            "url": n["url"],
            "body": n.get("body") or "",
            "comments_list": [
                {
                    "url": c.get("url"),
                    "created_at": c.get("createdAt"),
                    "author": {
                        "login": ((c.get("author") or {}).get("login") or "ghost"),
                        "avatar_url": (c.get("author") or {}).get("avatarUrl"),
                    },
                    "body": c.get("body") or "",
                }
                for c in (n.get("comments", {}).get("nodes", []) or [])
            ],
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
    task_locations = build_task_location_map(tree)
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
    pr_nodes = paged(PR_QUERY, "pullRequests", max_pages=16)
    backfill_pr_comments(pr_nodes)
    discussion_nodes = paged(DISCUSSION_QUERY, "discussions")

    # Build proposals first so we can backreference them when linking PRs.
    # We pass an empty pr_titles list initially since has_pr can still update
    # after PR build, but the PR's linked_proposal points back here.
    proposals_pre = build_proposals(discussion_nodes, now, [], field_to_domain)
    prs = build_prs(pr_nodes, now, taxonomy, field_to_domain, task_locations, proposals_pre)
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
            "closed_proposals": sum(1 for p in proposals if p["state"] == "closed"),
            "approved_proposals": sum(1 for p in proposals if p["status"] == "approved"),
            "declined_proposals": sum(1 for p in proposals if p["status"] == "rejected"),
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

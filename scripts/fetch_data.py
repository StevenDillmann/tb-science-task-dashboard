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
import os
import random
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from typing import Any, Callable

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

# Conflict-of-interest disclosure from the proposal form ("Commercial Affiliation
# & Conflicts of Interest:"). Capture the value up to the next blank line, the
# `---` form footer, or end of body.
COI_RE = re.compile(
    r"(?:Commercial\s+Affiliation\s*&?\s*)?Conflicts?\s+of\s+Interest\s*:?[ \t]*\n?"
    r"(?P<coi>.*?)(?:\n\s*\n|\n\s*---|\Z)",
    re.IGNORECASE | re.DOTALL,
)
# Values that mean "no conflict declared" → treated as no disclosure (None).
_COI_NONE = {"", "none", "n-a", "na", "n/a", "no", "n.a."}


def parse_coi(body: str) -> str | None:
    """The proposal's declared conflict of interest, or None when not disclosed.

    Returns the disclosure text only when a real conflict is stated; empty /
    "None" / "N/A" answers collapse to None so the dashboard can flag only the
    proposals that actually declare something.
    """
    m = COI_RE.search((body or "").replace("**", ""))
    if not m:
        return None
    val = " ".join(m.group("coi").split()).strip(" .")
    return None if val.lower() in _COI_NONE else val


def parse_proposal_author(body: str) -> tuple[str | None, str | None]:
    """Return (login, display_name) for the original proposal submitter.

    Prefer the `Proposed by @handle` legacy line; otherwise pull the handle
    from a `GitHub: https://github.com/<handle>` line under
    `## Author Information`. `display_name` is the human name from the
    `Author:` field when present.
    """
    # Strip markdown bold so bolded form labels (**Author:**, **GitHub:**) still
    # match the plain-label regexes.
    body = (body or "").replace("**", "")
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


class GHError(RuntimeError):
    """Raised when a `gh` call fails after exhausting all retries.

    Distinct from SystemExit so callers can catch it and fall back to cached
    data (see main's graceful-degradation blocks) instead of aborting the whole
    run. An uncaught GHError still exits non-zero (see __main__).
    """


def gh(args: list[str], *, retries: int = 8) -> str:
    """Run a `gh` command, retrying transient API failures with backoff.

    The GitHub API intermittently returns a truncated/empty body (`gh` then
    exits non-zero with "unexpected end of JSON input"), drops the HTTP/2 stream
    ("stream error: … CANCEL; received from peer"), or gateway-times-out
    (HTTP 504) when it's under load. A single such blip used to abort the whole
    fetch — and with many calls per run, the rebuild failed most of the time.
    Every call here expects a non-empty JSON body, so treat a non-zero exit OR
    empty stdout as transient and retry with jittered exponential backoff; only
    give up (raising GHError) after `retries` attempts. Jitter spreads retries
    so a burst of concurrent rebuilds doesn't hammer the API in lockstep.
    """
    base = 2.0
    for attempt in range(retries + 1):
        res = subprocess.run(["gh", *args], capture_output=True, text=True, check=False)
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout
        if attempt < retries:
            # Equal-jitter backoff: half fixed, half random, capped.
            window = min(base * (2 ** attempt), 45.0)
            delay = window / 2 + random.uniform(0, window / 2)
            sys.stderr.write(
                f"gh call failed (attempt {attempt + 1}/{retries + 1}, "
                f"rc={res.returncode}): {res.stderr.strip()[:200] or 'empty body'} "
                f"— retrying in {delay:.0f}s\n"
            )
            time.sleep(delay)
            continue
        sys.stderr.write(res.stderr)
        raise GHError(res.stderr.strip()[:200] or f"gh exited {res.returncode}")
    raise GHError("gh: exhausted retries")  # unreachable


def graphql(query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
    args = ["api", "graphql", "-f", f"query={query}"]
    for k, v in (variables or {}).items():
        if isinstance(v, str):
            args += ["-f", f"{k}={v}"]
        else:
            args += ["-F", f"{k}={v}"]
    return json.loads(gh(args))


# --- Raw-node cache ---------------------------------------------------------
# We persist the raw GraphQL PR + discussion nodes (not the derived payload) so
# a later run can re-derive the whole set with the *current* build logic — the
# derivation (build_prs / build_proposals) evolves often, so caching derived
# rows would freeze untouched items at stale logic. The cache serves two ends:
#   * graceful degradation — fall back to it when the API is unreachable, so a
#     GitHub outage never freezes the deployed dashboard;
#   * incremental fetch — pull only what changed since it was written.
CACHE_VERSION = 1


def load_raw_cache(path: str | None) -> dict[str, Any]:
    """Load the prior run's raw nodes, or {} when absent/corrupt/stale-schema.

    A missing or unreadable cache is never fatal: the caller simply does a full
    fetch and self-heals.
    """
    if not path:
        return {}
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    if data.get("version") != CACHE_VERSION:
        return {}
    return data


def save_raw_cache(
    path: str | None,
    pr_nodes: list[dict[str, Any]],
    discussion_nodes: list[dict[str, Any]],
) -> None:
    """Atomically persist the raw nodes we ended up using this run."""
    if not path:
        return
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w") as f:
        json.dump(
            {
                "version": CACHE_VERSION,
                "pr_nodes": pr_nodes,
                "discussion_nodes": discussion_nodes,
            },
            f,
        )
    os.replace(tmp, path)


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

    A plain COUNT of approvals, not a sequential workflow position. The final
    reviewer approving does NOT jump a PR to "3rd" on its own — it counts as one
    approval like any other. This keeps the Stage bucket honest against its
    "N approvals" filter labels, so e.g. domain + final approved (technical
    still pending) reads as "2nd", not "3rd".

    Only the three real slots can advance the stage. A PR can carry assignees
    beyond its reviewer-slots marker, and their approval must not fill a gate no
    slotted reviewer has cleared: three dots with the final slot still pending
    reads as "all reviews complete" everywhere the stage is consumed (the filter
    bucket, and the "completed" affordance in ActionChip). Counting only slotted
    approvals keeps the count denominated in the same slots as the dots.

    Without a marker nobody has a role (most pre-parallel-model PRs), so there
    are no slots to denominate against and every approval counts.

      "none" → 0 approvals · "1st" → 1 · "2nd" → 2 · "3rd" → 3
    """
    if not reviewers:
        return "none"
    slotted = [r for r in reviewers if r.get("role")]
    counted = slotted or reviewers
    approvals = sum(1 for r in counted if r.get("status") == "approved")
    return {3: "3rd", 2: "2nd", 1: "1st"}.get(min(approvals, 3), "none")


def derive_ball_in_court(
    labels: list[str], reviewers: list[dict[str, Any]] | None = None
) -> str | None:
    """Whose court the PR is in — taken straight from the GitHub workflow label.

    The `waiting on …` labels are the team's source of truth for whose turn it
    is, and they track the live state (e.g. an author reply flips the label
    even though the reviewer's stale CHANGES_REQUESTED review stays sticky).

    - "waiting on author"   → author
    - "waiting on reviewer" → reviewer
    - neither label present  → None

    BOTH labels at once is not a state the workflow means to express — it's an
    upstream bug: the paths that hand the ball to the next reviewer add
    `waiting on reviewer` without clearing a `waiting on author` left over from
    an earlier changes-request. Label precedence would silently resolve that to
    `author`, parking a fully-approved PR in the author's queue (see #105:
    3/3 approved, still reading "waiting on author 5d"). So when the labels
    contradict each other, arbitrate with the reviewer statuses instead — they
    come from the reviews themselves and can't drift:

      - any slot wants changes → author
      - else any slot pending  → reviewer
      - else (every slot approved) → None, i.e. nothing left but the merge

    With no reviewer data to arbitrate with, keep the old label precedence.
    """
    on_author = "waiting on author" in labels
    on_reviewer = "waiting on reviewer" in labels
    if on_author and on_reviewer and reviewers:
        statuses = {r.get("status") for r in reviewers}
        if "changes_requested" in statuses:
            return "author"
        if "pending" in statuses:
            return "reviewer"
        return None
    if on_author:
        return "author"
    if on_reviewer:
        return "reviewer"
    return None


# Author–task fit is tagged directly on the PR with an `author-fit: <level>`
# label (the team's source of truth). "coi disclosed" is one of those levels; we
# surface it separately as the COI signal rather than as a fit level.
_FIT_LEVELS = ("direct", "adjacent", "unrelated")


def derive_author_fit(labels: list[str]) -> tuple[str | None, bool]:
    """Return (fit_level, coi_disclosed) from the PR's `author-fit: …` labels."""
    fit: str | None = None
    coi = False
    for lab in labels:
        if not lab.lower().startswith("author-fit:"):
            continue
        val = lab.split(":", 1)[1].strip().lower()
        if val == "coi disclosed":
            coi = True
        elif val in _FIT_LEVELS:
            fit = val
    return fit, coi


# Map ball-in-court → the GitHub label whose most-recent application marks when
# the PR entered that state.
_BALL_LABEL = {"author": "waiting on author", "reviewer": "waiting on reviewer"}


def ball_since(node: dict[str, Any], ball: str | None) -> str | None:
    """When the PR last entered its current waiting-on state.

    Base signal: the MOST RECENT `labeled` event for the ball's label (the labels
    toggle as the PR bounces between author and reviewer, so we want the latest
    application, not the first).

    For the *reviewer* state we also reset on the most recent review-request:
    the coarse `waiting on reviewer` label doesn't toggle when the ball advances
    from the parallel reviewers to the final reviewer, so without this the timer
    would keep counting from when review first started rather than from when the
    ball landed on the current reviewer.

    None if the ball is unset or no matching event is found.
    """
    label_name = _BALL_LABEL.get(ball or "")
    if not label_name:
        return None
    consider_requests = ball == "reviewer"
    latest: str | None = None
    for it in (node.get("timelineItems", {}).get("nodes", []) or []):
        typ = it.get("__typename")
        if typ == "LabeledEvent":
            if (it.get("label") or {}).get("name") != label_name:
                continue
        elif typ == "ReviewRequestedEvent":
            if not consider_requests:
                continue
        else:
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


# Headings of the two sticky bot comments the checks workflow maintains. The
# "Automated Checks" comment is the umbrella (links to every sub-check); the
# "Static Checks" comment is the detail table (canary strings, task fields,
# timeout cap). Both are updated in place, so their URLs are stable across
# pushes. We match on the comment STARTING with the heading — the umbrella
# comment mentions "Static checks" in a bullet, and we must not mistake that
# bullet for the detail comment.
CI_COMMENT_HEADINGS = ("Static Checks", "Automated Checks")


def derive_ci_url(comments: list[dict[str, Any]], pr_url: str) -> str | None:
    """URL the CI dot links to — the checks summary comment, so a click lands
    on the failure detail rather than a bare status page.

    Prefers the sticky "Static Checks" comment (the ❌ detail table), falling
    back to the "Automated Checks" umbrella, then to the PR's Checks tab. Both
    comments are authored by the actions bot and updated in place; a newest-first
    scan finds the single live instance.
    """
    found: dict[str, str] = {}
    for c in reversed(comments):
        author = (c.get("author") or {}).get("login", "")
        if author not in LLM_REVIEW_BOTS:
            continue
        head = (c.get("bodyText") or "").lstrip()
        url = c.get("url")
        if not url:
            continue
        for heading in CI_COMMENT_HEADINGS:
            if heading not in found and head.startswith(heading):
                found[heading] = url
    for heading in CI_COMMENT_HEADINGS:  # priority order
        if heading in found:
            return found[heading]
    return f"{pr_url}/checks" if pr_url else None


def derive_type(labels: list[str]) -> str:
    for lab in ("task fix", "documentation", "new task"):
        if lab in labels:
            return lab
    return "other"


def derive_status(labels: list[str]) -> str:
    # Match by prefix — upstream appended emoji to the label names
    # ("proposal-approved ✅" / "proposal-declined ❌"), so exact matching would
    # miss them and read every proposal as pending.
    if any(lab.startswith("proposal-approved") for lab in labels):
        return "approved"
    if any(lab.startswith("proposal-declined") for lab in labels):
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
    # Strip markdown bold so a bolded heading / breadcrumb still parses.
    m = SCIENTIFIC_DOMAIN_RE.search((body or "").replace("**", ""))
    if not m:
        return None, None, None
    parts = [s.strip(" *") for s in m.group(1).split(">")]
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

# `__STATES__` is substituted with a state-filter literal (e.g. `[OPEN]`) rather
# than a GraphQL variable: `gh api graphql` can't pass a list-typed variable
# cleanly, and we fetch open vs closed/merged PRs on different cadences anyway
# (open fresh every run, closed/merged incrementally — see fetch_prs).
PR_QUERY = """
query($owner:String!,$name:String!,$first:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequests(states:__STATES__,first:$first,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){
      pageInfo{ hasNextPage endCursor }
      nodes{
        number title url isDraft state mergedAt closedAt createdAt updatedAt
        bodyText body headRefOid
        author{ login ... on User { avatarUrl } }
        labels(first:30){ nodes{ name color } }
        # Label-add history, newest last. Used to measure how long a PR has sat
        # in its current `waiting on author` / `waiting on reviewer` state (the
        # most recent time that label was applied), so stale hand-offs surface.
        timelineItems(last:60, itemTypes:[LABELED_EVENT, REVIEW_REQUESTED_EVENT]){
          nodes{
            __typename
            ... on LabeledEvent { createdAt label{ name } }
            ... on ReviewRequestedEvent { createdAt }
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
            createdAt
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
          createdAt
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

# Blended cost/runtime roll-up lines the /run comment posts under the trial
# table, each with its own denominator, e.g.
#   💰 Average cost across all trials: 94.0¢ (over 3 trial(s))
#   ⏱️ Average runtime across all trials: 3.0m (over 4 trial(s))
TRIAL_COST_RE = re.compile(
    r"Average cost across all trials\s*:\s*([^\n(]+?)\s*\(over\s+(\d+)\s+trial",
    re.IGNORECASE,
)
TRIAL_RUNTIME_RE = re.compile(
    r"Average runtime across all trials\s*:\s*([^\n(]+?)\s*\(over\s+(\d+)\s+trial",
    re.IGNORECASE,
)
# Blended pass-rate roll-up line, e.g. "✅ Pass rate across all trials: 33%
# (2/6 passed)" — the authoritative passed/total across every model & trial.
TRIAL_PASSRATE_RE = re.compile(
    r"Pass rate across all trials\s*:\s*\d+%\s*\(\s*(\d+)\s*/\s*(\d+)\s+passed",
    re.IGNORECASE,
)
# Same roll-up trio for the cheat comment (note "cheat trials" / "Successful
# cheats", so these never collide with the /run "all trials" lines above).
CHEAT_SUCCESS_RE = re.compile(
    r"Successful cheats\s*:\s*(\d+)\s*/\s*(\d+)",
    re.IGNORECASE,
)
CHEAT_COST_RE = re.compile(
    r"Average cost across cheat trials\s*:\s*([^\n(]+?)\s*\(over\s+(\d+)\s+trial",
    re.IGNORECASE,
)
CHEAT_RUNTIME_RE = re.compile(
    r"Average runtime across cheat trials\s*:\s*([^\n(]+?)\s*\(over\s+(\d+)\s+trial",
    re.IGNORECASE,
)


def _parse_cost_token(tok: str) -> float | None:
    """`$1.23` → 1.23, `94.0¢` → 0.94, `—`/blank → None (USD)."""
    tok = tok.strip()
    m = re.search(r"([\d.]+)", tok)
    if not m:
        return None
    val = float(m.group(1))
    return val / 100 if "¢" in tok else val


def _parse_duration_token(tok: str) -> int | None:
    """`3.0m` → 180, `45s` → 45, `—`/blank → None (seconds)."""
    tok = tok.strip()
    m = re.search(r"([\d.]+)", tok)
    if not m:
        return None
    val = float(m.group(1))
    return round(val * 60) if "m" in tok else round(val)

CHEAT_HEADER = "Cheating Agent Trial Results"
# In the cheat comment ✅ means the cheat SUCCEEDED (bad) and ❌ means the
# cheat was blocked (good). We're after a robust per-row "X of Y cheats
# blocked" view, so count ✅ = succeeded and ❌ = blocked across the trial
# table. Same caveat as trials about the per-criterion sub-tables — we slice
# to just the top trial table by stopping at "Job Analysis" / "Overall Results".


# Header cells naming a per-trial verdict column: "Trial 1", "Trial 2", …  in the
# /run table and "Cheat Trial" in the /cheat table. Everything else in the header
# row — "Model (Agent)", "Average", "Hub Link" — is a label, a roll-up, or a link,
# never a trial.
TRIAL_COL_RE = re.compile(r"\btrial\b", re.IGNORECASE)


def _trial_cell_picker(header_cells: list[str]):
    """Build a function that selects the per-trial cells from a table row.

    Match the `Trial N` / `Cheat Trial` headers by name rather than trimming a
    known trailing column: the /run and /cheat comments append columns over time
    (`Average`, then `Hub Link`), and a trailing-column heuristic silently counts
    each new one as an extra errored trial dot. Falls back to the old "drop a
    trailing Average" behaviour when no header matches, so tables from older
    comment formats still parse.
    """
    idx = [i for i, h in enumerate(header_cells) if TRIAL_COL_RE.search(h)]
    if idx:
        return lambda cells: [cells[i] for i in idx if i < len(cells)]
    drop_last = len(header_cells) > 2 and "average" in header_cells[-1].lower()
    return (lambda cells: cells[1:-1]) if drop_last else (lambda cells: cells[1:])


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
            pick_trials = lambda cells: cells[1:]  # noqa: E731 — replaced from the header row
            for line in tail.splitlines():
                if line.startswith("|"):
                    in_table = True
                    if "---" in line:
                        header_seen = True
                        continue
                    if not header_seen:
                        header_cells = [c.strip() for c in line.strip("|").split("|")]
                        pick_trials = _trial_cell_picker(header_cells)
                        continue
                    cells = [c.strip() for c in line.strip("|").split("|")]
                    if len(cells) < 2:
                        continue
                    model_label = cells[0]
                    display = re.sub(r"`", "", model_label).split("<br>")[0].strip()
                    results: list[str] = []
                    for cell in pick_trials(cells):
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

        # Prefer the authoritative "🔓 Successful cheats: X/Y" roll-up when
        # present (the rest not succeeded → blocked).
        succ_m = CHEAT_SUCCESS_RE.search(body_text)
        if succ_m:
            succeeded, total = int(succ_m.group(1)), int(succ_m.group(2))
            blocked = max(0, total - succeeded)

        # Blended cost/runtime across cheat trials (each over its own denominator).
        cost_m = CHEAT_COST_RE.search(body_text)
        runtime_m = CHEAT_RUNTIME_RE.search(body_text)
        avg_cost = _parse_cost_token(cost_m.group(1)) if cost_m else None
        avg_runtime = _parse_duration_token(runtime_m.group(1)) if runtime_m else None

        return {
            "succeeded": succeeded,
            "blocked": blocked,
            "total": total,
            "by_model": by_model,
            "url": c.get("url"),
            # True only when the "Successful cheats: X/Y" roll-up line was present
            # (mirrors trials — gate the summary on the authoritative roll-up).
            "has_rollup": succ_m is not None,
            "avg_cost_usd": avg_cost,
            "cost_trials": int(cost_m.group(2)) if cost_m else 0,
            "avg_runtime_secs": avg_runtime,
            "runtime_trials": int(runtime_m.group(2)) if runtime_m else 0,
        }
    return None


# A trial row for the oracle solution: `/run agents=oracle` runs `solve.sh`
# through the same harness as an agent, so it posts the SAME "Agent Trial
# Results" comment with `oracle` as the agent and no model.
ORACLE_AGENT_RE = re.compile(r"\(\s*`?oracle`?\s*\)")


def _classify_model(text: str) -> str:
    t = text.lower()
    # The oracle is not a model — but it rides the same table, so it gets its
    # own slug rather than falling into "other" and rendering as OTHER.
    if ORACLE_AGENT_RE.search(text):
        return "oracle"
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


def parse_trial_results(
    comments: list[dict[str, Any]],
    want_oracle: bool = False,
) -> dict[str, Any] | None:
    """Scan PR comments for the latest `🧪 Agent Trial Results` post and
    extract both the summary totals AND the per-model trial breakdown.

    Oracle runs post under the very same header, so the two are separated by
    the agent named in the table: `want_oracle` picks the latest all-oracle
    run, and the default picks the latest run with a real agent in it. Without
    that split an `/run agents=oracle` would be read as the newest agent run
    and wipe a task's agent trials out of the Trials column.

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
        oracle_rows = 0
        cell_pass = 0
        cell_verdict = 0  # pass + fail + errored — the count of attempted trials
        header_idx = body_md.find("Agent Trial Results")
        if header_idx >= 0:
            tail = body_md[header_idx:]
            # First non-trivial table is the trial table.
            # Split on lines, pick the first `|...|` block.
            in_table = False
            header_seen = False
            # Per-model "Average" / "Hub Link" columns are summaries, not trials —
            # pick the trial columns by header so they aren't counted as extra
            # (errored) trial cells.
            pick_trials = lambda cells: cells[1:]  # noqa: E731 — replaced from the header row
            for line in tail.splitlines():
                if line.startswith("|"):
                    if not in_table:
                        in_table = True
                    if "---" in line:
                        header_seen = True
                        continue
                    if not header_seen:
                        header_cells = [x.strip() for x in line.strip("|").split("|")]
                        pick_trials = _trial_cell_picker(header_cells)
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
                    for cell in pick_trials(cells):
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
                        if ORACLE_AGENT_RE.search(model_label):
                            oracle_rows += 1
                        by_model.append({
                            "model": _classify_model(model_label),
                            "display": display,
                            "results": results,
                        })
                elif in_table:
                    # First non-pipe line after entering the table = table end.
                    break

        # An all-oracle table is an oracle run; anything with a real agent in it
        # is an agent run. Mixed tables (never seen in practice) count as agent
        # runs, since that's the column their agent rows belong in.
        if (bool(by_model) and oracle_rows == len(by_model)) != want_oracle:
            continue

        # The auto-posted summary line is authoritative when present; otherwise
        # fall back to the counts derived from the table above.
        # Prefer the blended pass-rate roll-up (authoritative); fall back to the
        # legacy "N of M trials passed" summary, then to the derived cell counts.
        pr_m = TRIAL_PASSRATE_RE.search(body_text)
        sum_m = TRIAL_SUMMARY_RE.search(body_text)
        if pr_m:
            passed, total = int(pr_m.group(1)), int(pr_m.group(2))
        elif sum_m:
            passed, total = int(sum_m.group(1)), int(sum_m.group(2))
        else:
            passed, total = cell_pass, cell_verdict
        # total == 0 means no verdicts to show — most importantly this skips the
        # "🧪 Agent Trial Results ⏳" sticky placeholder posted while a run is
        # still in progress (header but empty table), so we keep showing the
        # last COMPLETED run until the new one finishes and fills its table in.
        if total == 0:
            continue

        # Blended cost/runtime roll-up (each over its own denominator, since a
        # trial only counts when its value is present and > 0).
        cost_m = TRIAL_COST_RE.search(body_text)
        runtime_m = TRIAL_RUNTIME_RE.search(body_text)
        avg_cost = _parse_cost_token(cost_m.group(1)) if cost_m else None
        avg_runtime = _parse_duration_token(runtime_m.group(1)) if runtime_m else None

        return {
            "passed": passed,
            "total": total,
            "by_model": by_model,
            "url": c.get("url"),
            # When this run was posted (shown in the chip's tooltip).
            "at": c.get("createdAt"),
            # True only when the comment carried the pass-rate roll-up line. The
            # summary (rate · cost · time) is shown only in that case, so the
            # displayed % is always the authoritative roll-up value and never a
            # cell-derived guess that can disagree with the trial dots.
            "has_rollup": pr_m is not None,
            "avg_cost_usd": avg_cost,
            "cost_trials": int(cost_m.group(2)) if cost_m else 0,
            "avg_runtime_secs": avg_runtime,
            "runtime_trials": int(runtime_m.group(2)) if runtime_m else 0,
        }
    return None

DISCUSSION_QUERY = """
query($owner:String!,$name:String!,$first:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    discussions(first:$first,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){
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
# Advisory author–task fit line from the separate author-aware pass. The label
# uses an en-dash ("Author–Task Fit"); `.?` tolerates that / a hyphen / nothing.
# ⚪ is the fail-soft/N-A badge → treated as no verdict (None).
LLM_AUTHOR_FIT_RE = re.compile(
    r"Author.?Task\s+Fit\s*:\s*(?P<emoji>🟢|🟡|🔴|⚪)",
    re.IGNORECASE,
)
# "Conflict of interest: ✅ None — …" (no conflict) vs a disclosed verdict
# (⚠️/🔴 + text). Skip the leading badge emoji, then read the verdict word/detail.
LLM_COI_RE = re.compile(
    r"Conflict of interest\s*:\s*(?:[^\w\s]+\s*)?(?P<rest>.+)",
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
        fit_m = LLM_AUTHOR_FIT_RE.search(body)
        author_fit = (
            {"🟢": "direct", "🟡": "adjacent", "🔴": "unrelated"}.get(fit_m.group("emoji"))
            if fit_m else None
        )
        # Structured "Conflict of interest" line → disclosure detail, or None when
        # the verdict is "None". `coi_seen` lets the caller fall back to scraping
        # the discussion body only when this line is absent (older reviews).
        coi_m = LLM_COI_RE.search(body)
        coi_seen = coi_m is not None
        coi: str | None = None
        if coi_m:
            rest = " ".join(coi_m.group("rest").split()).strip(" .—-")
            if rest and not rest.lower().startswith("none"):
                coi = rest
        m = LLM_RECOMMENDATION_RE.search(body)
        if not m:
            return {"recommendation": "unknown", "author_fit": author_fit,
                    "coi": coi, "coi_seen": coi_seen, "url": c.get("url")}
        emoji = m.group("emoji")
        rec = {"🟢": "accept", "🟡": "uncertain", "🔴": "reject"}.get(emoji, "unknown")
        return {"recommendation": rec, "author_fit": author_fit,
                "coi": coi, "coi_seen": coi_seen, "url": c.get("url")}
    return None


# Hidden machine-readable marker the proposal-review workflow emits into its
# sticky comment, e.g. "<!-- proposal-reviewer:k-rl field:biology -->". This is
# the authoritative signal — wording-independent, mirroring the reviewer-slots
# marker PRs carry. Read from raw `body` (HTML comments are stripped from
# `bodyText`).
PROPOSAL_REVIEWER_RE = re.compile(
    r"<!--\s*proposal-reviewer:\s*(?P<login>[A-Za-z0-9-]+)", re.IGNORECASE
)
# Fallback: the visible line the workflow renders, e.g.
# "- **Assigned reviewer (biology):** @k-rl". Covers proposals reviewed before
# the marker shipped, so the column isn't blank until the backlog is re-reviewed.
# `[^@\n]*` keeps the match on that one line so it can't run on to a later
# @mention; the "_unassigned_" case carries no @handle and so never matches.
ASSIGNED_REVIEWER_RE = re.compile(
    r"Assigned reviewer[^@\n]*@(?P<login>[A-Za-z0-9-]+)", re.IGNORECASE
)


def parse_assigned_reviewer(comments: list[dict[str, Any]]) -> str | None:
    """Return the assigned domain reviewer's login from the latest auto-posted
    proposal review comment, or None when unassigned / no such comment.

    Prefers the hidden `proposal-reviewer:` marker (upstream source of truth);
    falls back to scraping the visible "Assigned reviewer … @handle" line for
    older comments predating the marker. Scoped to the bot comment (the one that
    carries the rubric review) so a human can't spoof it with a stray mention.
    """
    for c in reversed(comments):  # most recent matching comment wins
        if (c.get("author") or {}).get("login", "") not in LLM_REVIEW_BOTS:
            continue
        marker = PROPOSAL_REVIEWER_RE.search(c.get("body", "") or "")
        if marker:
            return marker.group("login")
        prose = ASSIGNED_REVIEWER_RE.search(c.get("bodyText", "") or "")
        if prose:
            return prose.group("login")
    return None


def paged(
    query: str,
    key: str,
    *,
    extra_vars: dict[str, Any] | None = None,
    max_pages: int | None = None,
    stop: Callable[[dict[str, Any]], bool] | None = None,
) -> list[dict[str, Any]]:
    """Page a GraphQL connection, newest-first.

    `stop(node)` powers incremental fetch: when it returns True the node — and,
    because results are UPDATED_AT-DESC ordered, everything after it — is
    unchanged since the cache, so we drop the tail and return immediately.
    `extra_vars` supplies query variables beyond owner/name/cursor (e.g. first).
    """
    out: list[dict[str, Any]] = []
    cursor: str | None = None
    pages = 0
    while True:
        variables: dict[str, Any] = {"owner": UPSTREAM_OWNER, "name": UPSTREAM_NAME}
        if extra_vars:
            variables.update(extra_vars)
        if cursor:
            variables["cursor"] = cursor
        data = graphql(query, variables)
        block = data["data"]["repository"][key]
        for node in block["nodes"]:
            if stop and stop(node):
                return out
            out.append(node)
        pages += 1
        if not block["pageInfo"]["hasNextPage"]:
            break
        if max_pages is not None and pages >= max_pages:
            break
        cursor = block["pageInfo"]["endCursor"]
    return out


# Page sizes tuned small: a large nested page (files + comments + check contexts
# per PR) is exactly what GitHub gateway-times-out on under load. Smaller pages
# cost more round-trips but each is cheap enough to complete and be retried.
PR_PAGE = 10
DISC_PAGE = 25
# Rolling closed/merged-PR history kept in the cache/payload. Open PRs are
# always kept in full; without this bound, incremental merges would accumulate
# every PR ever seen and the payload would grow without limit. 40 cold-start
# pages of PR_PAGE fill exactly this window.
CLOSED_HISTORY = 400


def merge_nodes(
    base: list[dict[str, Any]],
    fresh: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Overlay freshly-fetched nodes onto cached ones, keyed by number.

    Fresh wins on collision; unfetched cached nodes are retained. Result is
    UPDATED_AT-DESC ordered to match a full `paged` fetch.
    """
    by_num = {n["number"]: n for n in base}
    for n in fresh:
        by_num[n["number"]] = n
    return sorted(by_num.values(), key=lambda n: n.get("updatedAt") or "", reverse=True)


def _unchanged(base: list[dict[str, Any]]) -> Callable[[dict[str, Any]], bool]:
    """Predicate: node's (number, updatedAt) already present in `base`."""
    seen = {n["number"]: n.get("updatedAt") for n in base}
    return lambda node: seen.get(node["number"]) == node["updatedAt"]


def fetch_prs(base: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], str]:
    """Fetch PR nodes, merged over `base`. Returns (nodes, "ok"|"stale").

    Open PRs are always fetched fresh: a CI check completing does NOT bump a
    PR's updatedAt, so an incremental-by-updatedAt scan would leave stale CI
    dots on open PRs. Closed/merged PRs are effectively immutable, so those are
    fetched incrementally (early-stop at the first unchanged one). A state
    transition (open→merged) bumps updatedAt to the top of the closed list, so
    it's always re-fetched and overwrites the stale open copy on merge.
    """
    stale = False
    fresh: list[dict[str, Any]] = []
    try:
        fresh += paged(
            PR_QUERY.replace("__STATES__", "[OPEN]"), "pullRequests",
            extra_vars={"first": PR_PAGE}, max_pages=20,
        )
    except GHError as e:
        if not base:
            raise
        sys.stderr.write(f"open-PR fetch failed ({e}); keeping cached open PRs.\n")
        stale = True
    try:
        # max_pages only bounds a COLD start (empty cache): warm runs early-stop
        # at the first unchanged PR. 40 pages preserves the same ~400-PR
        # closed/merged history window the pre-incremental full fetch had.
        fresh += paged(
            PR_QUERY.replace("__STATES__", "[CLOSED,MERGED]"), "pullRequests",
            extra_vars={"first": PR_PAGE}, max_pages=40, stop=_unchanged(base),
        )
    except GHError as e:
        if not base:
            raise
        sys.stderr.write(f"closed-PR fetch failed ({e}); keeping cached closed PRs.\n")
        stale = True
    backfill_pr_comments(fresh)  # only freshly-fetched PRs can need more comments
    merged = merge_nodes(base, fresh)
    # Bound growth: keep every open PR plus the most-recently-updated
    # CLOSED_HISTORY closed/merged ones (merged is already UPDATED_AT-DESC).
    open_nodes = [n for n in merged if n.get("state") == "OPEN"]
    closed_nodes = [n for n in merged if n.get("state") != "OPEN"]
    kept = sorted(
        open_nodes + closed_nodes[:CLOSED_HISTORY],
        key=lambda n: n.get("updatedAt") or "", reverse=True,
    )
    sys.stderr.write(
        f"PRs: {len(fresh)} fetched fresh, {len(base)} cached, {len(kept)} kept.\n"
    )
    return kept, ("stale" if stale else "ok")


def fetch_discussions(base: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], str]:
    """Fetch discussion nodes incrementally, merged over `base`.

    Unlike PRs, everything the dashboard reads off a discussion (comments, the
    rubric-review comment, labels, close state) bumps its updatedAt, so a pure
    incremental early-stop is safe — no open/closed split needed.
    """
    try:
        changed = paged(
            DISCUSSION_QUERY, "discussions",
            extra_vars={"first": DISC_PAGE}, max_pages=20, stop=_unchanged(base),
        )
    except GHError as e:
        if not base:
            raise
        sys.stderr.write(f"discussion fetch failed ({e}); keeping cached discussions.\n")
        return merge_nodes(base, []), "stale"
    sys.stderr.write(f"Discussions: {len(changed)} fetched fresh, {len(base)} cached.\n")
    return merge_nodes(base, changed), "ok"


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

    def build_row(
        n: dict[str, Any],
        labels: list[str],
        task_dir_hint: str | None = None,
    ) -> dict[str, Any]:
        """One dashboard row from one PR node.

        Shared by `new task` PRs (the rows themselves) and `task fix` PRs (the
        expandable subrows), so a fix fills the very same columns — its own CI,
        rubric, trials and reviewers — instead of a stub. `task_dir_hint` is the
        fix's task directory: a fix usually touches an EXISTING task.toml rather
        than adding one, so the ADDED-file detection below finds nothing.
        """
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
        # A fix PR that touches no task.toml at all still belongs to a task.
        task_dir = task_dir or task_dir_hint
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
        # Link the CI dot to the checks summary comment (falls back to the PR's
        # Checks tab) so a click lands on the failure detail.
        ci_url = derive_ci_url(comments, n["url"])
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
        # `/run agents=oracle` — the reference solution through the same harness.
        # Its own column, so it can't be mistaken for an agent result.
        oracle_trials = parse_trial_results(comments, want_oracle=True)
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
                # Human-review status of the source proposal (approved / pending
                # / rejected), so the PR table can flag it next to the link.
                "status": linked["status"],
            }
            if linked
            else None
        )
        # Author–task fit + COI straight from the PR's own `author-fit:` labels.
        pr_fit, pr_coi = derive_author_fit(labels)
        # Whose court + how long it's been there (only meaningful for open PRs).
        # `reviewers` is passed so a contradictory pair of `waiting on …` labels
        # is resolved from the actual review statuses rather than by precedence.
        ball = derive_ball_in_court(labels, reviewers) if state == "open" else None
        ball_at = ball_since(n, ball)
        return {
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
            # Author–task fit and COI come straight from the PR's own
            # `author-fit: …` labels (team's source of truth). Fall back to the
            # linked proposal's assessment only when the PR carries no such label.
            "coi": (
                (linked["coi"] if linked and linked.get("coi") else "disclosed")
                if pr_coi
                else (linked["coi"] if linked else None)
            ),
            "author_fit": (
                pr_fit
                if (pr_fit or pr_coi)
                else ((linked.get("llm_review") or {}).get("author_fit") if linked else None)
            ),
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
            "ci_url": ci_url,
            "trials": trials,
            "oracle_trials": oracle_trials,
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
        }

    # First pass: build a full row for every `task fix` PR, grouped by the task
    # directory it touches. Fix PRs are never rows of their own — they hang off
    # their parent task's row as `fix_rows` and surface only when expanded.
    fix_rows_by_task_dir: dict[str, list[dict[str, Any]]] = {}
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
        fix_rows_by_task_dir.setdefault(fix_task_dir, []).append(
            build_row(n, labels, task_dir_hint=fix_task_dir)
        )

    rows = []
    for n in nodes:
        labels = [lab["name"] for lab in n["labels"]["nodes"]]
        # Source of truth = upstream labels. Mislabeled PRs are an upstream
        # issue to fix there, not here.
        if "new task" not in labels:
            continue
        row = build_row(n, labels)
        task_dir = row["task_dir"]
        # Closed (abandoned) fixes are kept: the subrows are opt-in behind a
        # click, so showing the full fix history beats hiding part of it. Their
        # state is on the row itself.
        row["fix_rows"] = sorted(
            fix_rows_by_task_dir.get(task_dir, []) if task_dir else [],
            key=lambda f: f["number"],
        )
        rows.append(row)
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

        comment_nodes = n.get("comments", {}).get("nodes", []) or []
        llm_review = parse_llm_review(comment_nodes)
        # Domain reviewer assigned by the proposal-review workflow (read from its
        # sticky comment — upstream is the source of truth). None when unassigned.
        reviewer_login = parse_assigned_reviewer(comment_nodes)
        reviewer = (
            {
                "login": reviewer_login,
                "avatar_url": f"https://github.com/{reviewer_login}.png?size=80",
            }
            if reviewer_login
            else None
        )
        # Author-fit + COI are now tagged directly on the discussion with the same
        # `author-fit: …` labels as PRs (upstream source of truth). Fall back to
        # the rubric-review comment only when the proposal carries no such label.
        prop_fit, prop_coi = derive_author_fit(labels)
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
            # Author-fit label first; else the rubric review's verdict.
            "author_fit": (
                prop_fit if prop_fit
                else (llm_review.get("author_fit") if llm_review else None)
            ),
            # COI: the `coi disclosed` label first (add-only, authoritative); else
            # the structured review line; else scrape the discussion body.
            "coi": (
                (llm_review["coi"] if llm_review and llm_review.get("coi") else "disclosed")
                if prop_coi
                else (
                    llm_review["coi"] if llm_review and llm_review.get("coi_seen")
                    else parse_coi(n.get("body") or "")
                )
            ),
            "status": status,
            "state": state,
            "closed": bool(n.get("closed")),
            "reviewer": reviewer,
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
    ap.add_argument(
        "--cache",
        default=None,
        help="Raw-node cache path. Enables fall-back-on-outage and incremental "
             "fetch across runs. Omit for a stateless full fetch.",
    )
    args = ap.parse_args()

    now = datetime.now(timezone.utc)

    cache = load_raw_cache(args.cache)
    base_pr_nodes = cache.get("pr_nodes", []) or []
    base_discussion_nodes = cache.get("discussion_nodes", []) or []

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

    # Incrementally fetch PRs and discussions over the cached nodes, each
    # falling back to the cache for whatever the API can't serve — so a GitHub
    # outage leaves the affected tab stale rather than freezing (or failing) the
    # whole dashboard. With no cache to fall back on (cold start), a total
    # failure still propagates and aborts the run.
    pr_nodes, prs_status = fetch_prs(base_pr_nodes)
    discussion_nodes, proposals_status = fetch_discussions(base_discussion_nodes)
    fetch_status = {"prs": prs_status, "proposals": proposals_status}

    # Persist whatever we ended up with (fresh + carried-over cache) so the next
    # run has a warm base to fetch incrementally against — even after a stale run.
    save_raw_cache(args.cache, pr_nodes, discussion_nodes)

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
        # Per-section freshness: "stale" means the API was unreachable and this
        # section fell back to the last cached fetch. The UI can surface a badge.
        "fetch_status": fetch_status,
        "partial": any(v != "ok" for v in fetch_status.values()),
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
    try:
        raise SystemExit(main())
    except GHError as e:
        # An essential call (taxonomy tree) or a cold-start fetch with no cache
        # to fall back on exhausted its retries. Nothing we can safely deploy.
        sys.stderr.write(f"fatal: {e}\n")
        raise SystemExit(1)

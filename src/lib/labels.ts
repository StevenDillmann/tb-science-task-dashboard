// The upstream labels surfaced as tags — as a chip beside the task title and as
// the Task column's Tags filter. An allowlist, not "everything left over": every
// other label upstream uses is already shown some other way (state pills, the
// stage column, Action, author fit, proposal status), so mirroring them here
// would say the same thing twice. Adding a tag is a one-line change here plus a
// colour in TAG_STYLES.
const KNOWN_TAGS = ["gpu", "lite"]

/** The tags on a PR, in KNOWN_TAGS order so the chips don't reshuffle between
 *  rows just because upstream returned the labels in a different order. */
export function tagLabels(labels: string[]): string[] {
  return KNOWN_TAGS.filter((t) => labels.includes(t))
}

// Labels that already drive a dedicated column or filter (state, stage, ball,
// author fit, proposal status). Folding these into the search haystack would
// make common words match nearly every row — "task" would hit all 161 PRs via
// "new task" — so search only sees the labels nothing else surfaces.
const COVERED_LABEL_PREFIXES = [
  "new task",
  "task fix",
  "waiting on",
  "author-fit:",
  "proposal-",
  "documentation",
]

/** What free-text search matches on. Deliberately broader than `tagLabels`: a
 *  label upstream adds tomorrow stays findable by typing its name even before it
 *  earns a chip and a colour of its own. */
export function searchableLabels(labels: string[]): string[] {
  return labels.filter(
    (l) =>
      // The `… review ✅` labels are the stage column's own source data.
      !l.endsWith("review ✅") &&
      !COVERED_LABEL_PREFIXES.some((p) => l.startsWith(p)),
  )
}

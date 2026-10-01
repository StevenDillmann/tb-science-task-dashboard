/** An extra item for a table's state toggle (All / Open / Merged …), supplied
 *  by the page embedding the table — e.g. "Waiting on you" in the Reviewer To
 *  Do tab. Unlike the built-in states it is a subset rather than a partition
 *  (it sits inside Open), so it is listed right after All. Selected by the
 *  `mine` state value; it is the table's default whenever it is present. */
export type ExtraState<T> = { label: string; match: (row: T) => boolean }

/** Terminal-Bench-Science teal, the same tone the toggle uses for Lite. */
export const EXTRA_STATE_TONE =
  "bg-[#038F99]/15 text-[#036f78] dark:bg-[#038F99]/25 dark:text-[#4fc3cc]"

import { useCallback, useEffect, useState } from "react"

/**
 * Two-way bind a piece of view state to a URL query param, so filtered / opened
 * views are shareable, bookmarkable, and survive reload + back/forward.
 *
 * - Reads its initial value from the URL (falling back to `defaultValue`).
 * - Writes changes back with history.replaceState — no history spam on every
 *   filter toggle. The param is dropped from the URL when the value equals the
 *   default, so shared links stay minimal (e.g. the default `state=open` and
 *   empty search never appear).
 * - Stays in sync with browser back/forward and manual URL edits via popstate.
 *
 * Multiple hooks can target the same URL: each write only touches its own key,
 * re-reading the live query string first, so they never clobber one another.
 */
export function useUrlState<T>(
  key: string,
  defaultValue: T,
  codec: Codec<T> = stringCodec as unknown as Codec<T>,
): [T, (v: T) => void] {
  const read = useCallback((): T => {
    if (typeof window === "undefined") return defaultValue
    const raw = new URLSearchParams(window.location.search).get(key)
    return raw === null ? defaultValue : codec.decode(raw)
  }, [key, defaultValue, codec])

  const [value, setValue] = useState<T>(read)

  // Reflect back/forward navigation and manual URL edits.
  useEffect(() => {
    const onPop = () => setValue(read())
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [read])

  const set = useCallback(
    (v: T) => {
      setValue(v)
      if (typeof window === "undefined") return
      const params = new URLSearchParams(window.location.search)
      const encoded = codec.encode(v)
      // Drop the param when it matches the default so shared URLs stay minimal.
      if (encoded === null || encoded === codec.encode(defaultValue)) {
        params.delete(key)
      } else {
        params.set(key, encoded)
      }
      const qs = params.toString()
      window.history.replaceState(
        null,
        "",
        qs ? `${window.location.pathname}?${qs}` : window.location.pathname,
      )
    },
    [key, defaultValue, codec],
  )

  return [value, set]
}

type Codec<T> = {
  encode: (v: T) => string | null
  decode: (s: string) => T
}

// Default: plain strings (and string | null). Empty string encodes to null so
// it's treated as "unset" and dropped from the URL.
const stringCodec: Codec<string | null> = {
  encode: (v) => (v == null || v === "" ? null : v),
  decode: (s) => s,
}

// For multi-select filters: a comma-separated list. Empty list → dropped.
export const stringArrayCodec: Codec<string[]> = {
  encode: (v) => (v.length ? v.join(",") : null),
  decode: (s) => (s ? s.split(",").filter(Boolean) : []),
}

// For numeric state (e.g. an opened PR / proposal number).
export const numberCodec: Codec<number | null> = {
  encode: (v) => (v == null ? null : String(v)),
  decode: (s) => {
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  },
}

// Shared "pretty name" helpers for datasets and skills. Recording stamps a
// dataset repo as `<user>/<task-slug>_<YYYYMMDD>_<HHMMSS>`, which is ugly and
// makes two recordings of the same task look identical. These turn the repo id
// into a readable title plus a recorded-date you can tell collisions apart by.

const STAMP = /_(\d{8})_(\d{6})$/; // trailing _YYYYMMDD_HHMMSS from recording

/** The task slug: last path segment with the recording timestamp stripped. */
export function datasetSlug(repoId: string): string {
  const last = repoId.split("/").pop() ?? repoId;
  return last.replace(STAMP, "");
}

/** A readable, sentence-cased title — e.g. "move-an-item_2026…" -> "Move an item". */
export function prettyName(repoId: string): string {
  const words = datasetSlug(repoId).replace(/[-_]+/g, " ").trim();
  if (!words) return repoId;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The Date encoded in the recording timestamp, or null if there isn't one. */
export function recordedAt(repoId: string): Date | null {
  const last = repoId.split("/").pop() ?? "";
  const m = last.match(STAMP);
  if (!m) return null;
  const [d, t] = [m[1], m[2]];
  const date = new Date(
    +d.slice(0, 4),
    +d.slice(4, 6) - 1,
    +d.slice(6, 8),
    +t.slice(0, 2),
    +t.slice(2, 4),
    +t.slice(4, 6),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Jun 23, 2026" from the recording timestamp, or null. */
export function recordedAtLabel(repoId: string): string | null {
  const d = recordedAt(repoId);
  return d
    ? d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : null;
}

/**
 * Lowercased pretty names that appear more than once in `repoIds`. Callers
 * highlight the date / raw id for these so same-named items are distinguishable.
 */
export function collidingNames(repoIds: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const id of repoIds) {
    const key = prettyName(id).toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, c]) => c > 1).map(([key]) => key));
}

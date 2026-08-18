/**
 * Shared evidence-formatting helpers.
 *
 * Repo-wide convention:
 * findings quote the instruction text that triggered them, never the
 * detector's own regex source. A report reader who is shown
 * `/\bread\s+all\s+(?:docs|documentation)\b/i` cannot act on it — they cannot
 * even tell which line of their file is at fault. A reader shown
 * `Reads all documentation at once: "read all documentation"` can.
 */

/** Collapse whitespace and clip to `maxLen`, appending an ellipsis when clipped. */
export function snippet(text: string, maxLen = 120): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= maxLen ? clean : `${clean.slice(0, maxLen)}…`;
}

/**
 * Returns the first match of `pattern` in `content` as a display-ready
 * snippet, or undefined when the pattern does not match.
 *
 * The pattern is cloned without the `g` flag so a shared module-level regex
 * cannot leak `lastIndex` state between calls.
 */
export function firstMatch(content: string, pattern: RegExp, maxLen = 120): string | undefined {
  const re = new RegExp(pattern.source, pattern.flags.replace('g', ''));
  const m = re.exec(content);
  return m ? snippet(m[0], maxLen) : undefined;
}

/**
 * Builds a single evidence line: a human-readable label plus the matched
 * instruction text. Falls back to the bare label if the pattern somehow does
 * not match (callers normally test first), so evidence is never empty and
 * never contains regex source.
 */
export function matchEvidence(
  content: string,
  pattern: RegExp,
  label: string,
  maxLen = 120,
): string {
  const matched = firstMatch(content, pattern, maxLen);
  return matched ? `${label}: "${matched}"` : label;
}

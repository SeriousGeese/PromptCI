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

const INVISIBLE_CATEGORY_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/u;

/** Code point label used wherever an invisible character must be shown: `<U+200B>`. */
export function codepointLabel(cp: number): string {
  return `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>`;
}

/** Anything that does not render as itself (control, format, filler, selector…). */
export function isDisplayHidden(ch: string, cp: number = ch.codePointAt(0)!): boolean {
  if (cp === 0x09 || (cp >= 0x20 && cp < 0x7f)) return false;
  return INVISIBLE_CATEGORY_RE.test(ch) ||
    cp === 0x2028 || cp === 0x2029 || cp === 0x3164 || cp === 0xffa0 || cp === 0x115f || cp === 0x1160 ||
    cp === 0x034f || cp === 0x17b4 || cp === 0x17b5 ||
    (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef) || (cp >= 0x180b && cp <= 0x180f);
}

/**
 * Render untrusted text safely for evidence, summaries and report paths: every
 * invisible, control or format character becomes `<U+XXXX>` (tab excepted),
 * and a run of Unicode tag characters is decoded to its ASCII payload as
 * `<TAGS:"…">` so a smuggled instruction is readable, not hidden.
 */
export function visibleText(text: string): string {
  let out = '';
  let tags = '';
  const flush = () => {
    if (tags) out += `<TAGS:"${tags}">`;
    tags = '';
  };
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xe0000 && cp <= 0xe007f) {
      tags += cp >= 0xe0020 && cp <= 0xe007e ? String.fromCharCode(cp - 0xe0000) : codepointLabel(cp);
      continue;
    }
    flush();
    out += isDisplayHidden(ch, cp) ? codepointLabel(cp) : ch;
  }
  flush();
  return out;
}

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

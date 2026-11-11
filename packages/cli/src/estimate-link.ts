/**
 * The link `promptci scan` prints so a visitor can drop their measured numbers
 * into the homepage savings calculator without uploading anything.
 *
 * It carries exactly two non-negative integers and nothing else: no repo name,
 * path, file name or finding text. Both values are coerced to integers here so
 * a caller cannot smuggle a string through.
 */

/** Single source of truth for the marketing-site origin the CLI links to. */
export const SITE_URL = 'https://promptci.seriousgeese.dev';

function toCount(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function buildEstimateLink(tokens: number, addressable: number): string {
  return `${SITE_URL}/?tokens=${toCount(tokens)}&addressable=${toCount(addressable)}#estimate`;
}

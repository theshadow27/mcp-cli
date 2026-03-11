/**
 * Detect production log noise in test output.
 *
 * Matches daemon log prefixes ([mcpd], [_claude], [_aliases], [alias-*])
 * and production signals (MCPD_READY) that should not appear during test runs.
 */

/** Patterns that indicate production log output leaking into tests. */
const NOISE_PATTERNS = [/^\[mcpd\]/, /^\[_claude\]/, /^\[_aliases\]/, /^\[alias[-\w]*\]/, /^MCPD_READY$/];

/**
 * Scan test output for production log noise lines.
 * Returns the matched lines (trimmed).
 */
export function detectTestNoise(text: string): string[] {
  const results: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && NOISE_PATTERNS.some((p) => p.test(trimmed))) {
      results.push(trimmed);
    }
  }
  return results;
}

/**
 * Reads stdin line-by-line and scans for PII / secret patterns.
 * Exit 0 = clean, exit 1 = secrets found, exit 2 = scanner error (fail-closed).
 *
 * Used by the pre-commit hook to gate recordings/ and binaries/ additions.
 */
import { scanSecrets } from "../packages/core/src/sanitizer";

async function main(): Promise<void> {
  const chunks: string[] = [];
  const reader = Bun.stdin.stream().getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(new TextDecoder().decode(value));
  }

  const text = chunks.join("");
  if (!text.trim()) {
    process.exit(0);
  }

  const { matches, clean } = scanSecrets(text);
  if (clean) {
    process.exit(0);
  }

  const grouped = new Map<string, number>();
  for (const m of matches) {
    grouped.set(m.pattern, (grouped.get(m.pattern) ?? 0) + 1);
  }

  console.error(`scan-secrets: ${matches.length} secret(s) detected:`);
  for (const [pattern, count] of grouped) {
    console.error(`  ${pattern}: ${count} match(es)`);
  }

  process.exit(1);
}

main().catch(() => {
  console.error("scan-secrets: scanner error (fail-closed)");
  process.exit(2);
});

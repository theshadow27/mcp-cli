/** Core impl-phase logic, extracted for testability. */

export function buildImplPrompt(issueNumber: number, prNumber: number | null): string {
  const resolveStep =
    prNumber != null
      ? `\nAfter replying to each addressed thread, resolve it: mcx pr comments ${prNumber} resolve --all-addressed`
      : "";
  return `/implement ${issueNumber}${resolveStep}`;
}

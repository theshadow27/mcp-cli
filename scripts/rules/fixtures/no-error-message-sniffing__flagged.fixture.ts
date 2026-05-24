/**
 * @rule no-error-message-sniffing
 * @expect 4
 * @path packages/daemon/src/example-sniffing.ts
 *
 * Four control-flow branches keyed on message text — all should be flagged.
 */

declare const err: { message: string };
declare function retry(): void;

export function startsWith(): void {
  if (err.message.startsWith("OAuth callback timeout")) {
    retry();
  }
}

export function includes(): boolean {
  return err.message.includes("403") ? true : false;
}

export function matchInWhile(): void {
  while (err.message.match(/ECONNRESET/)) {
    retry();
  }
}

export function switchSniff(): string {
  switch (true) {
    case err.message.includes("not found"):
      return "missing";
    default:
      return "other";
  }
}

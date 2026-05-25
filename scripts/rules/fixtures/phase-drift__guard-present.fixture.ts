/**
 * @rule phase-drift
 * @expect 0
 * @path packages/command/src/commands/phase.ts
 *
 * The `sub === "run"` block calls assertNoDrift — clean.
 */

declare const sub: string;
declare const args: string[];
declare function assertNoDrift(d: unknown): void;
declare function runPhase(argv: string[], d: unknown): Promise<void>;
declare const d: unknown;

export async function dispatch(): Promise<void> {
  if (sub === "run") {
    const argv = args.slice(1);
    assertNoDrift(d);
    await runPhase(argv, d);
    return;
  }
}

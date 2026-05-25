/**
 * @rule phase-drift
 * @expect 1
 * @path packages/command/src/commands/phase.ts
 *
 * The `sub === "run"` block dispatches without calling
 * assertNoDrift / detectDrift — must be flagged.
 *
 * An unrelated `assertNoDrift` call in another branch must NOT satisfy
 * the rule (the call has to live inside the run-block).
 */

declare const sub: string;
declare const args: string[];
declare function assertNoDrift(d: unknown): void;
declare function runPhase(argv: string[], d: unknown): Promise<void>;
declare const d: unknown;

export async function dispatch(): Promise<void> {
  if (sub === "install") {
    assertNoDrift(d);
    return;
  }
  if (sub === "run") {
    const argv = args.slice(1);
    await runPhase(argv, d);
    return;
  }
}

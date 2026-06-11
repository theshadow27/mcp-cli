#!/usr/bin/env bun
/**
 * check-introspection-round — mechanical guard for the introspection cadence (#2506).
 *
 * The sprint skill requires a code-first introspection round during the retro of
 * every sprint whose number ends in 7 (see
 * .claude/skills/sprint/references/introspection.md). The sprint-57 round was
 * skipped silently because the cadence was prose-only. This script makes the
 * check load-bearing: the retro runs it before clearing the sprint sentinel and
 * MUST NOT proceed on a non-zero exit.
 *
 * A round is evidenced by a tracking issue whose title contains
 * "introspection round" and the sprint number ("sprint-67" / "sprint 67"),
 * following the #2511 convention ("epic: sprint-67 introspection round … —
 * tracking"). The cadence meta-issue #1867 intentionally does NOT match (its
 * "(next: sprint 57)" suffix is what a naive matcher would have false-passed
 * on for the exact round that was skipped).
 *
 * Usage:  bun scripts/check-introspection-round.ts <sprint-number>
 *
 * Exit 0: sprint doesn't end in 7, or a tracking issue exists.
 * Exit 1: sprint ends in 7 and no tracking issue found (or gh unreachable).
 */

const GH_TIMEOUT_MS = 10_000;

export interface IssueRef {
  number: number;
  title: string;
}

export type IssueLister = () => Promise<IssueRef[] | null>;

/** Output sink — defaults write to the process streams; tests inject a capturing buffer. */
export type Sink = (s: string) => void;

export function isIntrospectionSprint(sprint: number): boolean {
  return Number.isInteger(sprint) && sprint > 0 && sprint % 10 === 7;
}

export function findTrackingIssue(issues: IssueRef[], sprint: number): IssueRef | null {
  const sprintRe = new RegExp(`sprint[-\\s]${sprint}\\b`, "i");
  for (const issue of issues) {
    if (!/introspection round/i.test(issue.title)) continue;
    if (!sprintRe.test(issue.title)) continue;
    return issue;
  }
  return null;
}

export async function listIntrospectionIssuesViaGh(): Promise<IssueRef[] | null> {
  const proc = Bun.spawn(
    [
      "gh",
      "issue",
      "list",
      "--state",
      "all",
      "--search",
      "introspection in:title",
      "--json",
      "number,title",
      "--limit",
      "100",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => proc.kill(), GH_TIMEOUT_MS);
  try {
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const text = await new Response(proc.stdout).text();
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    const refs: IssueRef[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const num = (entry as Record<string, unknown>).number;
      const title = (entry as Record<string, unknown>).title;
      if (typeof num !== "number" || typeof title !== "string") continue;
      refs.push({ number: num, title });
    }
    return refs;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const defaultOut: Sink = (s) => {
  process.stdout.write(s);
};
const defaultErr: Sink = (s) => {
  process.stderr.write(s);
};

export async function runCheck(
  sprint: number,
  listIssues: IssueLister,
  out: Sink = defaultOut,
  err: Sink = defaultErr,
): Promise<number> {
  if (!Number.isInteger(sprint) || sprint <= 0) {
    err("usage: bun scripts/check-introspection-round.ts <sprint-number>\n");
    return 1;
  }
  if (!isIntrospectionSprint(sprint)) {
    out(`✓ sprint ${sprint} does not end in 7 — no introspection round required\n`);
    return 0;
  }

  const issues = await listIssues();
  if (issues === null) {
    err("✗ could not reach GitHub API — cannot verify the introspection round; do not proceed blind\n");
    return 1;
  }

  const tracking = findTrackingIssue(issues, sprint);
  if (tracking !== null) {
    out(`✓ sprint ${sprint} introspection round tracked by #${tracking.number}: ${tracking.title}\n`);
    return 0;
  }

  err(`✗ sprint ${sprint} ends in 7 but no introspection-round tracking issue exists.\n`);
  err("  The retro is BLOCKED until the round runs (see .claude/skills/sprint/references/introspection.md).\n");
  err(
    `  Run the round, then file its tracking issue titled like: "epic: sprint-${sprint} introspection round — tracking"\n`,
  );
  return 1;
}

if (import.meta.main) {
  const sprint = Number.parseInt(process.argv[2] ?? "", 10);
  const code = await runCheck(sprint, listIntrospectionIssuesViaGh);
  process.exit(code);
}

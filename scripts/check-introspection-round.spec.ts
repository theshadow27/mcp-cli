import { describe, expect, test } from "bun:test";
import { type IssueRef, findTrackingIssue, isIntrospectionSprint, runCheck } from "./check-introspection-round";

const ROUND_67: IssueRef = {
  number: 2511,
  title: "epic: sprint-67 introspection round (code-first + transcript) — tracking",
};
const CADENCE_META: IssueRef = {
  number: 1867,
  title: "meta: every 10 sprints, run code-first introspection + file initiatives (next: sprint 57)",
};

function capture(): { sink: (s: string) => void; text: () => string } {
  const chunks: string[] = [];
  return {
    sink: (s) => {
      chunks.push(s);
    },
    text: () => chunks.join(""),
  };
}

describe("isIntrospectionSprint", () => {
  test("true only for positive integers ending in 7", () => {
    expect(isIntrospectionSprint(7)).toBe(true);
    expect(isIntrospectionSprint(57)).toBe(true);
    expect(isIntrospectionSprint(77)).toBe(true);
    expect(isIntrospectionSprint(73)).toBe(false);
    expect(isIntrospectionSprint(70)).toBe(false);
    expect(isIntrospectionSprint(0)).toBe(false);
    expect(isIntrospectionSprint(-7)).toBe(false);
    expect(isIntrospectionSprint(7.7)).toBe(false);
  });
});

describe("findTrackingIssue", () => {
  test("matches the #2511 round-issue convention", () => {
    expect(findTrackingIssue([CADENCE_META, ROUND_67], 67)).toEqual(ROUND_67);
  });

  test("accepts 'sprint 67' with a space", () => {
    const issue: IssueRef = { number: 9, title: "sprint 67 introspection round" };
    expect(findTrackingIssue([issue], 67)).toEqual(issue);
  });

  test("does NOT match the cadence meta-issue via its '(next: sprint 57)' suffix", () => {
    // The sprint-57 round was skipped; #1867 mentioning "sprint 57" must not
    // count as evidence that it ran (#2506 root cause).
    expect(findTrackingIssue([CADENCE_META], 57)).toBeNull();
  });

  test("requires the sprint number as a whole word", () => {
    expect(findTrackingIssue([ROUND_67], 6)).toBeNull();
    expect(findTrackingIssue([ROUND_67], 7)).toBeNull();
  });

  test("requires 'introspection round' in the title", () => {
    const vague: IssueRef = { number: 5, title: "sprint-77 introspection ideas" };
    expect(findTrackingIssue([vague], 77)).toBeNull();
  });
});

describe("runCheck", () => {
  test("passes without listing issues when sprint does not end in 7", async () => {
    const out = capture();
    let listed = false;
    const code = await runCheck(
      73,
      async () => {
        listed = true;
        return [];
      },
      out.sink,
      out.sink,
    );
    expect(code).toBe(0);
    expect(listed).toBe(false);
    expect(out.text()).toContain("does not end in 7");
  });

  test("passes when a tracking issue exists", async () => {
    const out = capture();
    const code = await runCheck(67, async () => [CADENCE_META, ROUND_67], out.sink, out.sink);
    expect(code).toBe(0);
    expect(out.text()).toContain("#2511");
  });

  test("fails when sprint ends in 7 and no tracking issue exists", async () => {
    const err = capture();
    const code = await runCheck(77, async () => [CADENCE_META, ROUND_67], err.sink, err.sink);
    expect(code).toBe(1);
    expect(err.text()).toContain("BLOCKED");
    expect(err.text()).toContain("sprint-77 introspection round");
  });

  test("fails closed when gh is unreachable", async () => {
    const err = capture();
    const code = await runCheck(77, async () => null, err.sink, err.sink);
    expect(code).toBe(1);
    expect(err.text()).toContain("do not proceed blind");
  });

  test("rejects a missing/garbage sprint argument", async () => {
    const err = capture();
    const code = await runCheck(Number.NaN, async () => [], err.sink, err.sink);
    expect(code).toBe(1);
    expect(err.text()).toContain("usage:");
  });
});

import { describe, expect, test } from "bun:test";
import { type CommitExec, resolveBuildCommit } from "./build-commit";

const SHA = "4f1a9c3d0b72e5a6b8c9d0e1f2a3b4c5d6e7f809";

/** Fake git: map of joined command → result. Unlisted commands fail. */
function fakeGit(responses: Record<string, { exitCode?: number; stdout?: string }>): CommitExec {
  return (cmd) => {
    const key = cmd.join(" ");
    const res = responses[key];
    if (!res) return { exitCode: 1, stdout: "" };
    return { exitCode: res.exitCode ?? 0, stdout: res.stdout ?? "" };
  };
}

describe("resolveBuildCommit", () => {
  test("returns the short SHA for a clean tree", () => {
    const commit = resolveBuildCommit(
      fakeGit({
        "git rev-parse HEAD": { stdout: `${SHA}\n` },
        "git status --porcelain": { stdout: "" },
      }),
    );
    expect(commit).toBe("4f1a9c3d0b72");
  });

  test("marks a dirty tree", () => {
    const commit = resolveBuildCommit(
      fakeGit({
        "git rev-parse HEAD": { stdout: `${SHA}\n` },
        "git status --porcelain": { stdout: " M scripts/build.ts\n?? junk\n" },
      }),
    );
    expect(commit).toBe("4f1a9c3d0b72-dirty");
  });

  test("marks the tree unknown when the dirty probe fails rather than claiming clean", () => {
    const commit = resolveBuildCommit(
      fakeGit({
        "git rev-parse HEAD": { stdout: `${SHA}\n` },
        "git status --porcelain": { exitCode: 128, stdout: "" },
      }),
    );
    expect(commit).toBe("4f1a9c3d0b72-unknown");
  });

  test("returns null when git can't resolve HEAD (no repo, no git)", () => {
    expect(resolveBuildCommit(fakeGit({}))).toBeNull();
  });

  test("returns null when HEAD output isn't a SHA", () => {
    const commit = resolveBuildCommit(
      fakeGit({
        "git rev-parse HEAD": { stdout: "HEAD\n" },
        "git status --porcelain": { stdout: "" },
      }),
    );
    expect(commit).toBeNull();
  });

  test("default exec produces a well-formed stamp or nothing at all", () => {
    // Tolerates a non-repo cwd (null); asserts the shape whenever git answers.
    const commit = resolveBuildCommit();
    if (commit !== null) expect(commit).toMatch(/^[0-9a-f]{12}(-dirty|-unknown)?$/);
  });
});

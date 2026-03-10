import { describe, expect, mock, test } from "bun:test";
import { type ExecFn, fixCoreBare } from "./git";

describe("fixCoreBare", () => {
  test("resets core.bare when it is true", () => {
    const calls: string[][] = [];
    const exec: ExecFn = mock((cmd: string[]) => {
      calls.push(cmd);
      if (cmd.includes("core.bare") && cmd.length === 5) {
        // git config core.bare (read)
        return { stdout: "true\n", exitCode: 0 };
      }
      // git config core.bare false (write)
      return { stdout: "", exitCode: 0 };
    });

    const result = fixCoreBare("/repo", exec);

    expect(result).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(["git", "-C", "/repo", "config", "core.bare"]);
    expect(calls[1]).toEqual(["git", "-C", "/repo", "config", "core.bare", "false"]);
  });

  test("does nothing when core.bare is false", () => {
    const exec: ExecFn = mock((cmd: string[]) => {
      return { stdout: "false\n", exitCode: 0 };
    });

    const result = fixCoreBare("/repo", exec);

    expect(result).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  test("does nothing when core.bare is not set", () => {
    const exec: ExecFn = mock(() => {
      return { stdout: "", exitCode: 1 };
    });

    const result = fixCoreBare("/repo", exec);

    expect(result).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

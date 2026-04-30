import { describe, expect, test } from "bun:test";
import { checkMethodViolation, findAsyncMethods } from "./check-session-teardown";

describe("findAsyncMethods", () => {
  test("finds a simple async method", () => {
    const lines = ["class Foo {", "  async bar(x: string): Promise<void> {", "    await something();", "  }", "}"];
    const methods = findAsyncMethods(lines);
    expect(methods).toHaveLength(1);
    expect(methods[0].name).toBe("bar");
    expect(methods[0].startLine).toBe(1);
    expect(methods[0].endLine).toBe(3);
  });

  test("finds method with access modifiers", () => {
    const lines = [
      "class Foo {",
      "  private async terminateSession(id: string, s: Session): Promise<void> {",
      "    await this.kill();",
      "  }",
      "}",
    ];
    const methods = findAsyncMethods(lines);
    expect(methods).toHaveLength(1);
    expect(methods[0].name).toBe("terminateSession");
  });

  test("finds method with multi-line signature", () => {
    const lines = [
      "  async bye(",
      "    sessionId: string,",
      "    message?: string,",
      "  ): Promise<void> {",
      "    this.sessions.delete(sessionId);",
      "    await this.terminate();",
      "  }",
    ];
    const methods = findAsyncMethods(lines);
    expect(methods).toHaveLength(1);
    expect(methods[0].name).toBe("bye");
    expect(methods[0].startLine).toBe(0);
    expect(methods[0].endLine).toBe(6);
  });

  test("does not find non-async methods", () => {
    const lines = ["class Foo {", "  delete(id: string): void {", "    this.sessions.delete(id);", "  }", "}"];
    expect(findAsyncMethods(lines)).toHaveLength(0);
  });

  test("does not find anonymous async arrow functions", () => {
    const lines = [
      "  proc.exited.then(async () => {",
      "    await drainDone;",
      "    this.sessions.delete(id);",
      "  });",
    ];
    expect(findAsyncMethods(lines)).toHaveLength(0);
  });

  test("does not find async keyword in comments", () => {
    const lines = ["  // async fakeMethod(x: string) {", "  //   await something();", "  // }"];
    expect(findAsyncMethods(lines)).toHaveLength(0);
  });

  test("finds multiple async methods in sequence", () => {
    const lines = [
      "  async foo(): Promise<void> {",
      "    await a();",
      "  }",
      "  async bar(): Promise<void> {",
      "    await b();",
      "  }",
    ];
    const methods = findAsyncMethods(lines);
    expect(methods).toHaveLength(2);
    expect(methods[0].name).toBe("foo");
    expect(methods[1].name).toBe("bar");
  });
});

describe("checkMethodViolation", () => {
  test("no violation: delete before await", () => {
    const lines = [
      "  async bye(sessionId: string): Promise<void> {",
      "    const info = this.extract(sessionId);",
      "    this.sessions.delete(sessionId);",
      "    await this.terminate(sessionId);",
      "  }",
    ];
    const method = { name: "bye", startLine: 0, endLine: 4 };
    expect(checkMethodViolation(lines, method)).toBeNull();
  });

  test("violation: delete after first await", () => {
    const lines = [
      "  private async terminateSession(id: string): Promise<void> {",
      "    this.endState();",
      "    await this.killProc();",
      "    this.sessions.delete(id);",
      "  }",
    ];
    const method = { name: "terminateSession", startLine: 0, endLine: 4 };
    const result = checkMethodViolation(lines, method);
    expect(result).not.toBeNull();
    expect(result?.awaitLine).toBe(2); // 0-indexed line 2
    expect(result?.deleteLine).toBe(3); // 0-indexed line 3
  });

  test("no violation: delete but no await", () => {
    const lines = ["  removeUnspawned(id: string): void {", "    this.sessions.delete(id);", "  }"];
    const method = { name: "removeUnspawned", startLine: 0, endLine: 2 };
    expect(checkMethodViolation(lines, method)).toBeNull();
  });

  test("no violation: await but no delete", () => {
    const lines = ["  async stop(): Promise<void> {", "    await this.killAll();", "  }"];
    const method = { name: "stop", startLine: 0, endLine: 2 };
    expect(checkMethodViolation(lines, method)).toBeNull();
  });

  test("no violation: await comment does not count", () => {
    const lines = [
      "  async foo(): Promise<void> {",
      "    // await something(); ← this is not real",
      "    this.sessions.delete(id);",
      "    await this.realWork();",
      "  }",
    ];
    const method = { name: "foo", startLine: 0, endLine: 4 };
    // The comment line with 'await' should not count as the first await.
    // So delete at line 2 is before real await at line 3 → no violation.
    expect(checkMethodViolation(lines, method)).toBeNull();
  });

  test("no violation: inline comment await does not count as first await", () => {
    const lines = [
      "  async foo(): Promise<void> {",
      "    const x = 1; // await happens later",
      "    this.sessions.delete(id);",
      "    await this.realWork();",
      "  }",
    ];
    const method = { name: "foo", startLine: 0, endLine: 4 };
    expect(checkMethodViolation(lines, method)).toBeNull();
  });

  test("violation: delete after second await still detected", () => {
    const lines = [
      "  private async cleanup(id: string): Promise<void> {",
      "    await this.firstStep();",
      "    await this.secondStep();",
      "    this.sessions.delete(id);",
      "  }",
    ];
    const method = { name: "cleanup", startLine: 0, endLine: 4 };
    const result = checkMethodViolation(lines, method);
    expect(result).not.toBeNull();
    // Reports the FIRST await (line 1), not the second
    expect(result?.awaitLine).toBe(1);
    expect(result?.deleteLine).toBe(3);
  });
});

import { describe, expect, it } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { ErrorBoundary } from "./error-boundary";

function Thrower({ error }: { error: Error }): never {
  throw error;
}

function makeError(message: string, stack: string): Error {
  const err = new Error(message);
  err.stack = stack;
  return err;
}

describe("ErrorBoundary", () => {
  it("renders children when no error", () => {
    const { lastFrame } = render(
      <ErrorBoundary>
        <Text>hello</Text>
      </ErrorBoundary>,
    );
    expect(lastFrame()).toContain("hello");
  });

  it("catches errors and displays the message", () => {
    const err = makeError("boom", "Error: boom\n    at Foo (foo.ts:1:2)");
    const { lastFrame } = render(
      <ErrorBoundary>
        <Thrower error={err} />
      </ErrorBoundary>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("mcpctl crashed: boom");
    expect(frame).toContain("at Foo (foo.ts:1:2)");
    expect(frame).toContain("Ctrl+C");
  });

  it("handles native-only stack frames without crashing", () => {
    const stack = ["TypeError: undefined is not an object", "    at native", "    at Object.run (/app.js:10:5)"].join(
      "\n",
    );
    const err = makeError("undefined is not an object", stack);
    const { lastFrame } = render(
      <ErrorBoundary>
        <Thrower error={err} />
      </ErrorBoundary>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("mcpctl crashed");
    expect(frame).toContain("at native");
    expect(frame).toContain("Object.run");
  });

  it("handles Bun compiled-binary style frames", () => {
    const stack = [
      "TypeError: t.type is undefined",
      "- ep (/$bunfs/root/mcpctl:208:5860)",
      "- Np (/$bunfs/root/mcpctl:231:2203)",
    ].join("\n");
    const err = makeError("t.type is undefined", stack);
    const { lastFrame } = render(
      <ErrorBoundary>
        <Thrower error={err} />
      </ErrorBoundary>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("mcpctl crashed: t.type is undefined");
    expect(frame).toContain("ep");
  });

  it("handles empty/trailing newlines in stack without duplicate keys", () => {
    const stack = "Error: fail\n    at A (a.ts:1:1)\n\n\n    at B (b.ts:2:2)\n";
    const err = makeError("fail", stack);
    const { lastFrame } = render(
      <ErrorBoundary>
        <Thrower error={err} />
      </ErrorBoundary>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("mcpctl crashed: fail");
    expect(frame).toContain("at A");
    expect(frame).toContain("at B");
  });

  it("handles error with no stack", () => {
    const err = new Error("no stack");
    err.stack = undefined;
    const { lastFrame } = render(
      <ErrorBoundary>
        <Thrower error={err} />
      </ErrorBoundary>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("mcpctl crashed: no stack");
  });
});

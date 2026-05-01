/**
 * Integration tests — git t5801 test suite ported to bun:test.
 *
 * Source: git's `t/t5801-remote-helpers.sh` (35 test cases).
 * Scope: as much of t5801 as can run at the protocol-layer today, against
 * `remote-protocol.ts` + an in-memory `MockProvider`.
 *
 * Tests that require a real git subprocess round-trip (fast-import emitter
 * for `import`, fast-import parser for `export`, and the `git-remote-mcx`
 * binary on PATH) are kept as `test.todo` with a comment pointing to the
 * issue that unblocks them. Follow-up PRs should convert `test.todo` into
 * real `test(...)` as the pieces land:
 *
 *   #1211 — import handler (fast-import stream writer, PR #1257)
 *   #1212 — export handler (fast-import stream parser → provider mutations)
 *   #1213 — argv[0] dispatch + `mcx install` symlink for `git-remote-mcx`
 *
 * Parent epic: #1209.
 */

import { describe, expect, test } from "bun:test";
import { type RemoteHelperHandlers, runProtocol } from "../remote-protocol";
import { type MockProvider, createMockProvider } from "./mock-provider";

const MARKS_DIR = "/tmp/test-marks-t5801";

// ── Stream helpers ────────────────────────────────────────────────

function streamFrom(input: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(input));
      controller.close();
    },
  });
}

function collectStream(): { stream: WritableStream<Uint8Array>; result: () => string } {
  const chunks: Uint8Array[] = [];
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    },
  });
  return {
    stream,
    result: () => new TextDecoder().decode(Buffer.concat(chunks)),
  };
}

// ── Handler factory — a minimal adapter from MockProvider → RemoteHelperHandlers ──

interface HandlerCounts {
  listCalls: number;
  importCalls: number;
  exportCalls: number;
  listForPushCalls: number;
  importedRefs: string[];
}

function makeHandlers(
  provider: MockProvider,
  counts: HandlerCounts = { listCalls: 0, importCalls: 0, exportCalls: 0, listForPushCalls: 0, importedRefs: [] },
): { handlers: RemoteHelperHandlers; counts: HandlerCounts } {
  const handlers: RemoteHelperHandlers = {
    list: async (forPush) => {
      counts.listCalls++;
      if (forPush) counts.listForPushCalls++;
      // Emulate what the real list will look like: one ref per entry under
      // refs/heads/main, with HEAD pointing at main. Deleted entries are
      // omitted so the caller observes the deletion.
      const scope = await provider.resolveScope({ key: "test" });
      const refs: string[] = [];
      const iter = provider.list(scope);
      let any = false;
      for await (const entry of iter) {
        if (!any) {
          refs.push("@refs/heads/main HEAD");
          refs.push("? refs/heads/main");
          any = true;
        }
        refs.push(`? refs/mcx/${entry.id}`);
      }
      if (!any) {
        // Empty repo: just HEAD symref so git can clone into an empty repo.
        refs.push("@refs/heads/main HEAD");
      }
      return `${refs.join("\n")}\n`;
    },
    handleImport: async (refs) => {
      counts.importCalls++;
      counts.importedRefs = refs;
      // Emit a minimal done marker; the real handler (PR #1257) emits a full
      // fast-import stream. This stub exists so the protocol loop can be
      // exercised end-to-end without depending on unmerged code.
      return "done\n";
    },
    handleExport: async (stdin) => {
      counts.exportCalls++;
      // Drain the stream so the pipeline completes.
      const reader = stdin.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
      return "ok refs/heads/main\n\n";
    },
  };
  return { handlers, counts };
}

async function runWith(input: string, provider: MockProvider): Promise<{ output: string; counts: HandlerCounts }> {
  const { handlers, counts } = makeHandlers(provider);
  const stdin = streamFrom(input);
  const { stream, result } = collectStream();
  await runProtocol(stdin, stream, handlers, { marksDir: MARKS_DIR });
  return { output: result(), counts };
}

// ── t5801: Clone (5 tests) ────────────────────────────────────────

describe("t5801 clone", () => {
  test("t5801-01: list reports refs for each provider entry", async () => {
    const provider = createMockProvider({
      entries: {
        README: { content: "# Hello", version: 1 },
        "docs-guide": { content: "# Guide", version: 1 },
      },
    });
    const { output } = await runWith("list\n\n", provider);
    expect(output).toContain("@refs/heads/main HEAD");
    expect(output).toContain("refs/heads/main");
    expect(output).toContain("refs/mcx/README");
    expect(output).toContain("refs/mcx/docs-guide");
  });

  test.todo("t5801-02: verify cloned content matches provider entries (needs #1211 import handler)", () => {});

  test("t5801-03: list output includes HEAD symref (needed for tracking refs on clone)", async () => {
    const provider = createMockProvider({ entries: { a: { content: "a", version: 1 } } });
    const { output } = await runWith("list\n\n", provider);
    expect(output).toMatch(/@refs\/heads\/main\s+HEAD/);
  });

  test.todo("t5801-04: clone with tags (needs #1211 — tag emission in import stream)", () => {});

  test("t5801-05: clone empty repo — list returns only HEAD symref", async () => {
    const provider = createMockProvider({ entries: {} });
    const { output } = await runWith("list\n\n", provider);
    expect(output).toContain("@refs/heads/main HEAD");
    expect(output).not.toContain("refs/mcx/");
  });
});

// ── t5801: Fetch (8 tests) ────────────────────────────────────────

describe("t5801 fetch", () => {
  test.todo("t5801-06: fetch after remote changes (needs #1211)", () => {});
  test.todo("t5801-07: incremental fetch — marks-based, only new objects (needs #1211)", () => {});

  test("t5801-08: fetch sees new branch — list reflects newly added entry", async () => {
    const provider = createMockProvider({ entries: { one: { content: "1", version: 1 } } });
    const first = await runWith("list\n\n", provider);
    expect(first.output).toContain("refs/mcx/one");
    expect(first.output).not.toContain("refs/mcx/two");

    // Simulate remote-side add
    provider.state.set("two", { content: "2", version: 1 });
    const second = await runWith("list\n\n", provider);
    expect(second.output).toContain("refs/mcx/one");
    expect(second.output).toContain("refs/mcx/two");
  });

  test("t5801-09: fetch sees deleted branch — deleted entries omitted from list", async () => {
    const provider = createMockProvider({
      entries: { a: { content: "a", version: 1 }, b: { content: "b", version: 1 } },
    });
    const before = await runWith("list\n\n", provider);
    expect(before.output).toContain("refs/mcx/a");
    expect(before.output).toContain("refs/mcx/b");

    await provider.delete?.({ key: "test", cloudId: "mock-cloud", resolved: {} }, "a");
    const after = await runWith("list\n\n", provider);
    expect(after.output).not.toContain("refs/mcx/a");
    expect(after.output).toContain("refs/mcx/b");
  });

  test.todo("t5801-10: fetch forced update (needs #1211)", () => {});
  test.todo("t5801-11: fetch tags (needs #1211)", () => {});

  test("t5801-12: `list for-push` dispatches with forPush=true", async () => {
    const provider = createMockProvider({ entries: { a: { content: "a", version: 1 } } });
    const { counts } = await runWith("list for-push\n\n", provider);
    expect(counts.listForPushCalls).toBe(1);
    expect(counts.listCalls).toBe(1);
  });

  test("t5801-13: fetch when up-to-date is a no-op — repeated list yields identical output", async () => {
    const provider = createMockProvider({ entries: { a: { content: "a", version: 1 } } });
    const first = await runWith("list\n\n", provider);
    const second = await runWith("list\n\n", provider);
    expect(first.output).toBe(second.output);
  });
});

// ── t5801: Push (10 tests) ────────────────────────────────────────

describe("t5801 push", () => {
  test.todo("t5801-14: push single commit (needs #1212 export handler)", () => {});
  test.todo("t5801-15: push multiple commits (needs #1212)", () => {});
  test.todo("t5801-16: push creates content on remote — provider.create called (needs #1212)", () => {});
  test.todo("t5801-17: push deletes content on remote — provider.delete called (needs #1212)", () => {});
  test.todo("t5801-18: push modified content — provider.push with version (needs #1212)", () => {});
  test.todo("t5801-19: push rejected on non-fast-forward — version conflict (needs #1212)", () => {});
  test.todo("t5801-20: force push (needs #1212)", () => {});
  test.todo("t5801-21: push with tags (needs #1212)", () => {});
  test.todo("t5801-22: push to new branch (needs #1212)", () => {});
  test.todo("t5801-23: push deletion (`:refs/heads/branch`) (needs #1212)", () => {});

  test("t5801 export command routes to handleExport", async () => {
    const provider = createMockProvider({ entries: { a: { content: "a", version: 1 } } });
    const { counts } = await runWith("export\nsome-fast-import-stream-payload\n", provider);
    expect(counts.exportCalls).toBe(1);
  });
});

// ── t5801: Options (3 tests) ──────────────────────────────────────

describe("t5801 options", () => {
  test("t5801-24: `option verbosity` returns ok", async () => {
    const provider = createMockProvider();
    const { output } = await runWith("option verbosity 2\n\n", provider);
    expect(output).toBe("ok\n");
  });

  test("t5801-25: `option progress` returns unsupported (not yet implemented)", async () => {
    const provider = createMockProvider();
    const { output } = await runWith("option progress true\n\n", provider);
    expect(output).toBe("unsupported\n");
  });

  test("t5801-26: unknown option returns unsupported", async () => {
    const provider = createMockProvider();
    const { output } = await runWith("option not-a-real-option whatever\n\n", provider);
    expect(output).toBe("unsupported\n");
  });
});

// ── t5801: Round-trip (5 tests) ───────────────────────────────────

describe("t5801 round-trip", () => {
  test.todo("t5801-27: clone → modify → push → re-clone → verify content (needs #1211+#1212)", () => {});
  test.todo("t5801-28: clone → push → remote modify → pull → verify merge (needs #1211+#1212)", () => {});
  test.todo("t5801-29: multiple sequential push/pull cycles (needs #1211+#1212)", () => {});
  test.todo("t5801-30: concurrent clone from same provider state (needs #1211)", () => {});
  test.todo("t5801-31: push after pull with no local changes — no-op (needs #1212)", () => {});
});

// ── t5801: Error handling (4 tests) ───────────────────────────────

describe("t5801 error handling", () => {
  // t5801-32/33 document the current "swallow-and-write-terminator" contract
  // used by `runProtocol` until real handlers land in #1211/#1212. When a
  // handler throws, `runProtocol` logs the error to stderr, writes a
  // terminator byte sequence to stdout, and resolves without propagating.
  //
  // The terminator bytes differ by command:
  //   - list/export → "\n" (empty status list + blank-line terminator).
  //     This is protocol-valid-but-uninformative: git sees zero ref updates.
  //   - import → "done\n". This is a PROTOCOL LIE: `done` is a fast-import
  //     directive meaning "commit all pending objects and exit 0". Writing it
  //     on error claims success. Today this is tolerated only because the
  //     stub `handleImport` never emits any fast-import directives before
  //     (theoretically) throwing, so fast-import commits nothing and the lie
  //     is a no-op. Once #1211 lands a real fast-import writer that can fail
  //     mid-stream, `done\n` on error would cause silent data corruption
  //     (partial commit) or a silent empty fetch — #1211 MUST replace this
  //     with either zero-byte output (letting fast-import error on
  //     truncation) or rejection propagation with a caller-side try/catch.
  //
  // See PR #1304 adversarial review for the full analysis. Do NOT treat the
  // `done\n` assertion below as protocol-correct behavior to preserve.
  test("t5801-32: provider list failure writes safe terminator and resolves", async () => {
    const handlers: RemoteHelperHandlers = {
      list: async () => {
        throw new Error("provider unreachable");
      },
      handleImport: async () => "done\n",
      handleExport: async () => "ok refs/heads/main\n\n",
    };
    const errors: string[] = [];
    const stdin = streamFrom("list\n\n");
    const { stream, result } = collectStream();
    await runProtocol(stdin, stream, handlers, { marksDir: MARKS_DIR, onError: (msg) => errors.push(msg) });
    // Stub-oracle only: bare "\n" is a blank terminator with zero status
    // lines. A real list handler should emit `@refs/... HEAD\n\n`; a real
    // error path per git-remote-helpers(1) has no list-failure syntax and
    // needs the caller-side exit decision from #1211/#1212.
    expect(result()).toBe("\n");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("provider unreachable");
  });

  test("t5801-33: provider push failure writes safe terminator and resolves", async () => {
    const handlers: RemoteHelperHandlers = {
      list: async () => "@refs/heads/main HEAD\n",
      handleImport: async () => "done\n",
      handleExport: async () => {
        throw new Error("push rejected: offline");
      },
    };
    const errors: string[] = [];
    const stdin = streamFrom("export\nstream-payload\n");
    const { stream, result } = collectStream();
    await runProtocol(stdin, stream, handlers, { marksDir: MARKS_DIR, onError: (msg) => errors.push(msg) });
    // Stub-oracle only: git-remote-helpers(1) requires per-ref
    // `ok <refname>\n` or `error <refname> <reason>\n` followed by a blank
    // line. Bare "\n" leaves git with no status for any ref. #1212 must
    // replace this with real per-ref error status lines.
    expect(result()).toBe("\n");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("push rejected: offline");
  });

  test.todo(
    "t5801-34: malformed remote URL — validated at `mcx vfs clone` layer, not protocol (needs #1215)",
    () => {},
  );

  test("t5801-35: helper exits cleanly on empty line", async () => {
    const provider = createMockProvider();
    const { output } = await runWith("\n", provider);
    expect(output).toBe("");
  });

  test("t5801-35b: helper exits cleanly on EOF with no trailing newline", async () => {
    const provider = createMockProvider();
    const { output } = await runWith("", provider);
    expect(output).toBe("");
  });

  test("t5801-35c: unknown command returns unsupported, loop continues", async () => {
    const provider = createMockProvider();
    const { output } = await runWith("connect refs/heads/main\nlist\n\n", provider);
    expect(output).toContain("unsupported\n");
    // After `unsupported`, the next command (list) still runs.
    expect(output).toContain("@refs/heads/main HEAD");
  });
});

// ── Capabilities (always testable at protocol layer) ──────────────

describe("t5801 capabilities", () => {
  test("capabilities advertises import, export, refspec, option, marks", async () => {
    const provider = createMockProvider();
    const { output } = await runWith("capabilities\n\n", provider);
    expect(output).toContain("import\n");
    expect(output).toContain("export\n");
    expect(output).toContain("refspec refs/heads/*:refs/mcx/*/heads/*\n");
    expect(output).toContain("option\n");
    expect(output).toContain(`*import-marks ${MARKS_DIR}/marks\n`);
    expect(output).toContain(`*export-marks ${MARKS_DIR}/marks\n`);
    // Block is terminated by a blank line
    expect(output.endsWith("\n\n")).toBe(true);
  });
});

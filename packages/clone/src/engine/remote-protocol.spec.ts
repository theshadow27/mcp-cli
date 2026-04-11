import { describe, expect, test } from "bun:test";
import { type RemoteHelperHandlers, runProtocol } from "./remote-protocol";

/** Encode a string as a ReadableStream<Uint8Array>. */
function streamFrom(input: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(input));
      controller.close();
    },
  });
}

/** Collect a WritableStream<Uint8Array> into a string. */
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

/** Create stub handlers that record calls. */
function makeHandlers(overrides: Partial<RemoteHelperHandlers> = {}): RemoteHelperHandlers {
  return {
    list: async (_forPush: boolean) => "@ refs/heads/main HEAD\nrefs/heads/main refs/heads/main\n",
    handleImport: async (_refs: string[]) => "done\n",
    handleExport: async (_stdin: ReadableStream<Uint8Array>) => "ok refs/heads/main\n\n",
    ...overrides,
  };
}

const MARKS_DIR = "/tmp/test-marks";

describe("remote-protocol", () => {
  test("capabilities response format", async () => {
    const stdin = streamFrom("capabilities\n\n");
    const { stream, result } = collectStream();
    await runProtocol(stdin, stream, makeHandlers(), { marksDir: MARKS_DIR });

    const output = result();
    expect(output).toContain("import\n");
    expect(output).toContain("export\n");
    expect(output).toContain("refspec refs/heads/*:refs/mcx/*/heads/*\n");
    expect(output).toContain("option\n");
    expect(output).toContain(`*import-marks ${MARKS_DIR}/marks\n`);
    expect(output).toContain(`*export-marks ${MARKS_DIR}/marks\n`);
    // Capabilities block ends with blank line
    expect(output).toContain("\n\n");
  });

  test("list dispatch (not for-push)", async () => {
    let calledForPush: boolean | undefined;
    const handlers = makeHandlers({
      list: async (forPush) => {
        calledForPush = forPush;
        return "@ refs/heads/main HEAD\n";
      },
    });

    const stdin = streamFrom("list\n\n");
    const { stream, result } = collectStream();
    await runProtocol(stdin, stream, handlers, { marksDir: MARKS_DIR });

    expect(calledForPush).toBe(false);
    expect(result()).toContain("@ refs/heads/main HEAD");
  });

  test("list for-push dispatch", async () => {
    let calledForPush: boolean | undefined;
    const handlers = makeHandlers({
      list: async (forPush) => {
        calledForPush = forPush;
        return "@ refs/heads/main HEAD\n";
      },
    });

    const stdin = streamFrom("list for-push\n\n");
    const { stream, result } = collectStream();
    await runProtocol(stdin, stream, handlers, { marksDir: MARKS_DIR });

    expect(calledForPush).toBe(true);
    expect(result()).toContain("@ refs/heads/main HEAD");
  });

  test("import batching (multiple refs)", async () => {
    let importedRefs: string[] = [];
    const handlers = makeHandlers({
      handleImport: async (refs) => {
        importedRefs = refs;
        return "done\n";
      },
    });

    const stdin = streamFrom("import refs/heads/main\nimport refs/heads/dev\nimport refs/heads/feature\n\n");
    const { stream, result } = collectStream();
    await runProtocol(stdin, stream, handlers, { marksDir: MARKS_DIR });

    expect(importedRefs).toEqual(["refs/heads/main", "refs/heads/dev", "refs/heads/feature"]);
    expect(result()).toContain("done");
  });

  test("import single ref", async () => {
    let importedRefs: string[] = [];
    const handlers = makeHandlers({
      handleImport: async (refs) => {
        importedRefs = refs;
        return "done\n";
      },
    });

    const stdin = streamFrom("import refs/heads/main\n\n");
    const { stream, result } = collectStream();
    await runProtocol(stdin, stream, handlers, { marksDir: MARKS_DIR });

    expect(importedRefs).toEqual(["refs/heads/main"]);
    expect(result()).toContain("done");
  });

  test("export dispatch", async () => {
    let exportCalled = false;
    const handlers = makeHandlers({
      handleExport: async (stdin) => {
        exportCalled = true;
        // Consume the stream
        const reader = stdin.getReader();
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
        return "ok refs/heads/main\n\n";
      },
    });

    const stdin = streamFrom("export\nsome-fast-import-data\n");
    const { stream, result } = collectStream();
    await runProtocol(stdin, stream, handlers, { marksDir: MARKS_DIR });

    expect(exportCalled).toBe(true);
    expect(result()).toContain("ok refs/heads/main");
  });

  test("option handling — supported option", async () => {
    const stdin = streamFrom("option verbosity 2\n\n");
    const { stream, result } = collectStream();
    await runProtocol(stdin, stream, makeHandlers(), { marksDir: MARKS_DIR });

    expect(result()).toBe("ok\n");
  });

  test("option handling — unsupported option", async () => {
    const stdin = streamFrom("option progress true\n\n");
    const { stream, result } = collectStream();
    await runProtocol(stdin, stream, makeHandlers(), { marksDir: MARKS_DIR });

    expect(result()).toBe("unsupported\n");
  });

  test("empty line exits cleanly", async () => {
    const stdin = streamFrom("\n");
    const { stream, result } = collectStream();
    await runProtocol(stdin, stream, makeHandlers(), { marksDir: MARKS_DIR });

    // Should exit without writing anything
    expect(result()).toBe("");
  });

  test("EOF exits cleanly", async () => {
    const stdin = streamFrom("");
    const { stream, result } = collectStream();
    await runProtocol(stdin, stream, makeHandlers(), { marksDir: MARKS_DIR });

    expect(result()).toBe("");
  });

  test("unknown command returns unsupported", async () => {
    const stdin = streamFrom("connect\n\n");
    const { stream, result } = collectStream();
    await runProtocol(stdin, stream, makeHandlers(), { marksDir: MARKS_DIR });

    expect(result()).toBe("unsupported\n");
  });

  test("multiple commands in sequence", async () => {
    let listCount = 0;
    const handlers = makeHandlers({
      list: async () => {
        listCount++;
        return `listing-${listCount}\n`;
      },
    });

    const stdin = streamFrom("capabilities\nlist\nlist for-push\n\n");
    const { stream, result } = collectStream();
    await runProtocol(stdin, stream, handlers, { marksDir: MARKS_DIR });

    const output = result();
    // Capabilities output
    expect(output).toContain("import\n");
    // Two list calls
    expect(listCount).toBe(2);
    expect(output).toContain("listing-1");
    expect(output).toContain("listing-2");
  });

  test("import followed by other command", async () => {
    let importedRefs: string[] = [];
    let listCalled = false;
    const handlers = makeHandlers({
      handleImport: async (refs) => {
        importedRefs = refs;
        return "done\n";
      },
      list: async () => {
        listCalled = true;
        return "refs\n";
      },
    });

    const stdin = streamFrom("import refs/heads/main\nimport refs/heads/dev\nlist\n\n");
    const { stream } = collectStream();
    await runProtocol(stdin, stream, handlers, { marksDir: MARKS_DIR });

    expect(importedRefs).toEqual(["refs/heads/main", "refs/heads/dev"]);
    expect(listCalled).toBe(true);
  });
});
